/**
 * Live mode (opt-in): start the project's dev server on a free port, call ONLY the requests
 * listed in the config, and record status codes and JSON shapes (types, never values).
 *
 * Safety: refuses to start when the project's database URL points at a non-local host
 * (unless allowed); sends headers only from the config and never stores or prints them or
 * any response value; never follows redirects; readiness is a TCP connect, not an HTTP call;
 * the server's whole process tree is always killed, including on errors and Ctrl+C.
 */
import type { PackageManager } from '../../core/config.js';
import { DevServerPool } from '../devServer.js';
import { shapeOfValue } from './shape.js';
import type { LiveCapture, LiveRequestResult, LiveSettings } from './types.js';

export { databaseSafety, freePort, killTree, type SafetyResult } from '../devServer.js';

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

export interface LiveOptions {
  root: string;
  settings: LiveSettings;
  packageManager: PackageManager;
  /** probes.database.envVar */
  dbEnvVar?: string;
  /** Environment the server inherits (default process.env). */
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  progress?: (msg: string) => void;
  /** Shared per-run servers (from before/after). Without one, a private pool is used and disposed. */
  pool?: DevServerPool;
}

/** `/api/x?token=abc&page=2` → `/api/x?token=…&page=…` */
export function redactPath(p: string): string {
  const q = p.indexOf('?');
  if (q < 0) return p;
  const params = p
    .slice(q + 1)
    .split('&')
    .filter(Boolean)
    .map((kv) => `${kv.split('=')[0]}=…`);
  return `${p.slice(0, q)}?${params.join('&')}`;
}

// --- Run ----------------------------------------------------------------------------------

export async function runLive(opts: LiveOptions): Promise<LiveCapture> {
  const s = opts.settings;
  if (!s.enabled || s.requests.length === 0) return { status: 'off', results: [] };
  const started = Date.now();
  const env = opts.env ?? process.env;

  // Validate the listed requests: only these are ever sent.
  const results: LiveRequestResult[] = [];
  const valid: { method: string; path: string; body?: unknown; headers: Record<string, string>; index: number }[] = [];
  for (const r of s.requests) {
    const method = (r.method ?? 'GET').toUpperCase();
    const shown = redactPath(r.path);
    const skip = (note: string) => results.push({ method, path: shown, error: 'skipped', note });
    if (!METHODS.has(method)) skip(`unsupported method ${method}`);
    else if (!r.path.startsWith('/') || r.path.startsWith('//') || r.path.includes('://')) skip('the path must start with / (no other hosts)');
    else if (method !== 'GET' && method !== 'HEAD' && !('body' in r)) skip(`${method} requests need a sample "body" in the config`);
    else {
      results.push({ method, path: shown });
      valid.push({ method, path: r.path, ...('body' in r ? { body: r.body } : {}), headers: { ...s.headers, ...(r.headers ?? {}) }, index: results.length - 1 });
    }
  }
  if (valid.length === 0) return { status: 'failed', message: 'no valid requests configured in probes.api.live.requests', results, ms: Date.now() - started };

  const pool = opts.pool ?? new DevServerPool();
  try {
    const server = await pool.acquire({
      root: opts.root,
      ...(s.command ? { command: s.command } : {}),
      packageManager: opts.packageManager,
      startupTimeoutSec: s.startupTimeoutSec,
      commandSetting: 'probes.api.live.command',
      env,
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.progress ? { progress: opts.progress } : {}),
      allowNonLocalDatabase: s.allowNonLocalDatabase,
      ...(opts.dbEnvVar ? { dbEnvVar: opts.dbEnvVar } : {}),
      settingKey: 'probes.api.live.allowNonLocalDatabase',
      what: 'live mode',
    });
    if (!server.ok) return { status: server.status, message: server.message, results: [], ms: Date.now() - started };
    for (const v of valid) {
      if (opts.signal?.aborted) break;
      opts.progress?.(`  calling ${v.method} ${redactPath(v.path)} …`);
      results[v.index] = { ...results[v.index]!, ...(await callOnce(server.origin, v, s.requestTimeoutSec * 1000, opts.signal)) };
    }
    return { status: 'ok', results, ms: Date.now() - started };
  } finally {
    if (!opts.pool) await pool.dispose();
  }
}

async function callOnce(
  origin: string,
  r: { method: string; path: string; body?: unknown; headers: Record<string, string> },
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Partial<LiveRequestResult>> {
  const t0 = Date.now();
  const headers: Record<string, string> = { ...r.headers };
  let body: string | undefined;
  if (r.body !== undefined && r.method !== 'GET' && r.method !== 'HEAD') {
    body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
  }
  const signals = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])];
  try {
    const res = await fetch(origin + r.path, { method: r.method, headers, ...(body !== undefined ? { body } : {}), redirect: 'manual', signal: AbortSignal.any(signals) });
    const contentType = res.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    const text = r.method === 'HEAD' ? '' : await res.text();
    const out: Partial<LiveRequestResult> = { status: res.status, ms: Date.now() - t0, ...(contentType ? { contentType } : {}) };
    const looksJson = contentType?.includes('json') || /^\s*[[{]/.test(text);
    if (looksJson && text.trim()) {
      try {
        out.shape = shapeOfValue(JSON.parse(text));
      } catch {
        out.shape = null;
        if (contentType?.includes('json')) out.error = 'invalid-json';
      }
    } else out.shape = null;
    return out;
  } catch (e) {
    const name = (e as Error).name;
    return { error: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'connection', ms: Date.now() - t0 };
  }
}
