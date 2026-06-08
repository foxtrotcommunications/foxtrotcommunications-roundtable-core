// server/protocols/nonceStore.ts — Replay Prevention
// In-memory nonce store with TTL cleanup. Prevents replay attacks
// on intent tokens by tracking seen nonces.

/** Thread-safe nonce store with automatic TTL-based cleanup */
export class NonceStore {
  private seen: Map<string, number> = new Map();  // nonce → expiry timestamp (ms)
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(cleanupIntervalMs: number = 60_000) {
    // Cleanup expired nonces periodically
    this.cleanupInterval = setInterval(() => this.cleanup(), cleanupIntervalMs);
    // Don't block process shutdown
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  /** Check if a nonce has been seen before */
  has(nonce: string): boolean {
    if (!this.seen.has(nonce)) return false;
    // Check if the nonce has expired (no longer blocking replays)
    const expiry = this.seen.get(nonce)!;
    if (Date.now() > expiry) {
      this.seen.delete(nonce);
      return false;
    }
    return true;
  }

  /** Record a nonce with a TTL. Returns false if the nonce was already seen (replay). */
  add(nonce: string, ttlMs: number = 600_000): boolean {
    if (this.has(nonce)) {
      return false;  // Replay detected
    }
    this.seen.set(nonce, Date.now() + ttlMs);
    return true;
  }

  /** Remove expired nonces */
  cleanup(): void {
    const now = Date.now();
    for (const [nonce, expiry] of this.seen.entries()) {
      if (now > expiry) {
        this.seen.delete(nonce);
      }
    }
  }

  /** Current store size (for metrics) */
  get size(): number {
    return this.seen.size;
  }

  /** Shut down the cleanup interval */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.seen.clear();
  }
}

// Singleton instance shared across the application
export const nonceStore = new NonceStore();
