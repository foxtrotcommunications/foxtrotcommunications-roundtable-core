// server/utils/wakeWorkspace.ts — wake a sleeping peer through the control plane.
//
// Before 3.1 a pod that hit a sleeping bridge target PATCHed the target's
// Deployment to 1 replica itself, with its own service-account token. That
// needed a namespace-wide Role and a mounted SA token on every tenant pod;
// 3.1 removed both (the PATCH now fails soft, and a tenant pod no longer
// carries a credential that can scale anything). The control plane serves
// the same operation as POST /api/internal/workspaces/:id/wake, and it checks
// what the pod could only assert: the requester is a workspace of the same
// org that shares an active bridge or contract with the target. Pooled
// targets are always awake and answer `already_running`.
//
// Wire (SIGNING_SPEC.md; CP api/routes/internal.ts): v2 routePath 'wake',
// tenant-bound to the REQUESTING workspace (X-Rt-Workspace = requester —
// the control plane reads the requester from the signature and the target
// from the URL, and refuses requester === target). Signed with the fleet
// BRIDGE_HMAC_SECRET like manifest/relay. Legacy X-Bridge-* headers over
// `${requester}:${ts}` ride alongside for a v1-only control plane.
//
// RT_LEGACY_INPOD_WAKE=true restores the in-pod k8s PATCH for one release
// (a cluster whose tenant SA still has patch rights and whose control plane
// has not shipped the wake route). Default false.

import crypto from 'crypto';
const config = require('../config');

export type WakeResult = 'scaled' | 'not_found' | 'failed';

export interface WakeOptions {
  /** The workspace asking (pooled: the tenant; dedicated: this pod). Bound into the signature. */
  requesterWsId: string;
  /** Log prefix, e.g. 'intent_bridge'. */
  source?: string;
  /** Test seam. */
  fetchImpl?: typeof fetch;
  /** Test seam for the legacy path. */
  inPodPatch?: (targetWsId: string, log: string) => Promise<WakeResult>;
}

export function legacyInPodWakeEnabled(): boolean {
  return String(process.env.RT_LEGACY_INPOD_WAKE || '').toLowerCase() === 'true';
}

export function controlPlaneUrl(): string {
  return process.env.CONTROL_PLANE_URL || 'https://roundtable.foxtrotcommunications.net';
}

/**
 * Ask the control plane to scale `targetWsId` from zero.
 *   'scaled'    — scaled now, or already running/starting (nothing to do)
 *   'not_found' — the control plane knows no such target in the requester's
 *                 org, or its Deployment is gone: the bridge is stale
 *   'failed'    — refused (not linked, bad signature), unreachable, or 5xx
 */
export async function wakeWorkspace(targetWsId: string, opts: WakeOptions): Promise<WakeResult> {
  const log = `[${opts.source || 'wake'}]`;
  if (legacyInPodWakeEnabled()) {
    return (opts.inPodPatch || inPodPatchWake)(targetWsId, log);
  }
  const requesterWsId = opts.requesterWsId;
  if (!requesterWsId) {
    console.error(`${log} wake of ${targetWsId} skipped: no requesting workspace id`);
    return 'failed';
  }
  if (requesterWsId === targetWsId) {
    console.error(`${log} wake of ${targetWsId} skipped: a workspace cannot wake itself`);
    return 'failed';
  }
  const secret: string = config.bridgeHmacSecret || '';
  const fetchFn = opts.fetchImpl || fetch;
  try {
    const { signPathV2, emitV2 } = require('./s2sSig');
    const body = JSON.stringify({ requesterWsId, source: opts.source || 'wake' });
    const timestamp = Date.now().toString();
    const legacySignature = crypto.createHmac('sha256', secret).update(`${requesterWsId}:${timestamp}`).digest('hex');
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Bridge-Signature': legacySignature,
      'X-Bridge-Timestamp': timestamp,
      'X-Bridge-WsId': requesterWsId,
      ...(emitV2() ? signPathV2({ secret, routePath: 'wake', body, tenantWsId: requesterWsId, timestamp }).headers : {}),
    };
    const url = `${controlPlaneUrl()}/api/internal/workspaces/${encodeURIComponent(targetWsId)}/wake`;
    const res = await fetchFn(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) });
    let data: any = null;
    try { data = await res.json(); } catch { /* non-JSON error body */ }
    if (res.ok) {
      console.log(`${log} control plane wake of ${targetWsId}: ${data?.status || 'ok'}`);
      return 'scaled';
    }
    if (res.status === 404 && (data?.status === 'not_found' || /target/i.test(String(data?.error || '')))) {
      console.warn(`${log} control plane: target ${targetWsId} not found — bridge is stale`);
      return 'not_found';
    }
    console.error(`${log} control plane wake of ${targetWsId} failed: HTTP ${res.status} ${data?.code || ''} ${data?.error || ''}`.trim());
    return 'failed';
  } catch (err: any) {
    console.error(`${log} control plane wake of ${targetWsId} error: ${err?.message}`);
    return 'failed';
  }
}

/**
 * Legacy (pre-3.1) in-pod Kubernetes PATCH of the target Deployment. Only
 * reachable under RT_LEGACY_INPOD_WAKE=true; scheduled for removal.
 */
export async function inPodPatchWake(targetWsId: string, log = '[wake]'): Promise<WakeResult> {
  try {
    const fs = require('fs');
    const https = require('https');
    const token = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8').trim();
    const ca = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt');
    const namespace = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/namespace', 'utf8').trim();
    const depName = `rt-ws-${targetWsId.slice(0, 12).toLowerCase()}`;
    const payload = JSON.stringify({ spec: { replicas: 1 } });
    const apiHost = process.env.KUBERNETES_SERVICE_HOST || 'kubernetes.default.svc';
    const apiPort = process.env.KUBERNETES_SERVICE_PORT || '443';
    return await new Promise<WakeResult>((resolve) => {
      const req = https.request({
        hostname: apiHost,
        port: Number(apiPort),
        path: `/apis/apps/v1/namespaces/${namespace}/deployments/${depName}`,
        method: 'PATCH',
        ca,
        rejectUnauthorized: true,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/strategic-merge-patch+json',
          'Content-Length': Buffer.byteLength(payload),
        },
      }, (res: any) => {
        let data = '';
        res.on('data', (c: string) => data += c);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            console.log(`${log} (legacy in-pod) scaled ${depName} → 1 replica in ns=${namespace}`);
            resolve('scaled');
          } else if (res.statusCode === 404) {
            console.warn(`${log} (legacy in-pod) deployment ${depName} not found — bridge is stale`);
            resolve('not_found');
          } else {
            console.error(`${log} (legacy in-pod) failed to scale ${depName}: ${res.statusCode} ${data.slice(0, 200)}`);
            resolve('failed');
          }
        });
      });
      req.on('error', (err: Error) => {
        console.error(`${log} (legacy in-pod) K8s API error: ${err.message}`);
        resolve('failed');
      });
      req.write(payload);
      req.end();
    });
  } catch (err: any) {
    console.error(`${log} (legacy in-pod) wake error: ${err?.message}`);
    return 'failed';
  }
}
