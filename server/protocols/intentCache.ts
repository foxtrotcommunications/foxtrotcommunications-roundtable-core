// server/protocols/intentCache.ts — Intent Result Cache
// Hash-based LRU cache for compiled intent execution results.
// Identical intents within a TTL window return cached results instantly,
// saving tool execution time and downstream API costs (BigQuery, etc.).

import crypto from 'crypto';
import { canonicalize } from './intentTokenCodec';
import type { IntentOperation, IntentResult } from './intentToken';

// ─── Types ──────────────────────────────────────────────────────────────────

interface CacheEntry {
  result: IntentResult;
  createdAt: number;
  ttlMs: number;
  accessCount: number;
  lastAccessed: number;
}

export interface CacheStats {
  size: number;
  maxSize: number;
  hits: number;
  misses: number;
  hitRate: number;
  evictions: number;
  defaultTtlMs: number;
}

export interface CacheConfig {
  maxSize?: number;     // Default: 1000 entries
  defaultTtlMs?: number; // Default: 60_000 (60s)
  cleanupIntervalMs?: number; // Default: 30_000 (30s)
}

// ─── Non-cacheable operations ───────────────────────────────────────────────

/** Operations that should never be cached */
const NON_CACHEABLE_OPS = new Set(['discover']);

/** Check if an intent is cacheable */
function isCacheable(intent: IntentOperation): boolean {
  if (NON_CACHEABLE_OPS.has(intent.op)) return false;
  // Don't cache aggregate ops — they contain multiple steps with side effects
  if (intent.op === 'aggregate') return false;
  return true;
}

// ─── Cache Implementation ───────────────────────────────────────────────────

export class IntentCache {
  private cache = new Map<string, CacheEntry>();
  private readonly maxSize: number;
  private readonly defaultTtlMs: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  // Stats
  private _hits = 0;
  private _misses = 0;
  private _evictions = 0;

  constructor(config: CacheConfig = {}) {
    this.maxSize = config.maxSize ?? 1000;
    this.defaultTtlMs = config.defaultTtlMs ?? 60_000;

    // Periodic cleanup of expired entries
    const cleanupInterval = config.cleanupIntervalMs ?? 30_000;
    this.cleanupTimer = setInterval(() => this.cleanup(), cleanupInterval);
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  // ─── Cache Key ──────────────────────────────────────────────────────────

  /**
   * Generate a deterministic cache key from an intent, scoped to the
   * executing workspace. The scope is part of the hash so two tenants
   * issuing byte-identical intents can NEVER share a cache entry — pods
   * are single-tenant today, but this must already be true the day a
   * process serves more than one workspace (multi-tenant Phase-0).
   */
  key(intent: IntentOperation, scope = ''): string {
    const canonical = canonicalize(intent as unknown as Record<string, unknown>);
    return crypto.createHash('sha256').update(scope + '\u0000' + canonical).digest('hex');
  }

  // ─── Get ────────────────────────────────────────────────────────────────

  /**
   * Look up a cached result for an intent.
   * Returns null on miss, expired entry, or non-cacheable op.
   */
  get(intent: IntentOperation, scope = ''): IntentResult | null {
    if (!isCacheable(intent)) {
      this._misses++;
      return null;
    }

    const k = this.key(intent, scope);
    const entry = this.cache.get(k);

    if (!entry) {
      this._misses++;
      return null;
    }

    // Check TTL expiry
    if (Date.now() - entry.createdAt > entry.ttlMs) {
      this.cache.delete(k);
      this._misses++;
      return null;
    }

    // Cache hit — update access stats
    entry.accessCount++;
    entry.lastAccessed = Date.now();
    this._hits++;
    return entry.result;
  }

  // ─── Set ────────────────────────────────────────────────────────────────

  /**
   * Cache a successful result for an intent.
   * Only caches successful results for cacheable operations.
   */
  set(intent: IntentOperation, result: IntentResult, ttlMs?: number, scope = ''): void {
    if (!isCacheable(intent)) return;
    if (result.status !== 'success') return; // Only cache successes

    const k = this.key(intent, scope);

    // Evict if at capacity (LRU: remove least recently accessed)
    if (this.cache.size >= this.maxSize && !this.cache.has(k)) {
      this.evictLRU();
    }

    this.cache.set(k, {
      result,
      createdAt: Date.now(),
      ttlMs: ttlMs ?? this.defaultTtlMs,
      accessCount: 1,
      lastAccessed: Date.now(),
    });
  }

  // ─── Invalidate ─────────────────────────────────────────────────────────

  /** Remove a specific intent from the cache */
  invalidate(intent: IntentOperation, scope = ''): boolean {
    return this.cache.delete(this.key(intent, scope));
  }

  /** Clear the entire cache */
  clear(): void {
    this.cache.clear();
    this._hits = 0;
    this._misses = 0;
    this._evictions = 0;
  }

  // ─── Stats ──────────────────────────────────────────────────────────────

  /** Get cache performance statistics */
  stats(): CacheStats {
    const total = this._hits + this._misses;
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hits: this._hits,
      misses: this._misses,
      hitRate: total > 0 ? Math.round((this._hits / total) * 10000) / 100 : 0,
      evictions: this._evictions,
      defaultTtlMs: this.defaultTtlMs,
    };
  }

  // ─── Internal ───────────────────────────────────────────────────────────

  /** Remove expired entries */
  private cleanup(): void {
    const now = Date.now();
    for (const [k, entry] of this.cache) {
      if (now - entry.createdAt > entry.ttlMs) {
        this.cache.delete(k);
      }
    }
  }

  /** Evict the least recently accessed entry */
  private evictLRU(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [k, entry] of this.cache) {
      if (entry.lastAccessed < oldestTime) {
        oldestTime = entry.lastAccessed;
        oldestKey = k;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
      this._evictions++;
    }
  }

  /** Stop the cleanup timer */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.cache.clear();
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

/** Global intent cache instance */
export const intentCache = new IntentCache();
