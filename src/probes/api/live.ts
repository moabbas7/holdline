/**
 * Live mode (opt-in): start the project's dev server on a free port, call ONLY the requests
 * listed in the config, and record status codes and JSON shapes (types, never values).
 *
 * Safety: refuses to start when the project's database URL points at a non-local host
 * (unless allowed); sends headers only from the config and never stores or prints them or
 * any response value; never follows redirects; readiness is a TCP connect, not an HTTP call;
 * the server's whole process tree is always killed, including on errors and Ctrl+C.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import type { PackageManager } from '../../core/config.js';
import { DEFAULT_ENV_VARS, ENV_FILES, parseDotenv } from '../database/live/env.js';
import { isLocalHost, parseConnectionString } from '../database/live/target.js';
import { shapeOfValue } from './shape.js';
import type { LiveCapture, LiveRequestResult, LiveSettings } from './types.js';

const SUPABASE_VARS = ['SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL'];
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const KILL_GRACE_MS = 3000;

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
}

// --- Database host check --------------------------------------------------------------

export type SafetyResult = { ok: true } | { ok: false; reason: string };

/** Host of any `scheme://[user[:pass]@]host[:port]/…` URL, or null. */
function genericHost(value: string): string | null {
  const m = /^[a-z][\w+.-]*:\/\/(?:[^@/?#]*@)?(\[[^\]]+\]|[^:/?#,]+)/i.exec(value.trim());
  return m ? m[1]!.toLowerCase() : null;
}

/**
 * Refuse when any database URL the dev server would see (the .env files it loads, or the
 * environment holdline runs in) points at a host that is not local. Values are never
 * returned or printed, only the variable, where it came from and the host.
 */
export async function databaseSafety(root: string, extraVar: string | undefined, env: NodeJS.ProcessEnv): Promise<SafetyResult> {
  const vars = [...new Set([...(extraVar ? [extraVar] : []), ...DEFAULT_ENV_VARS, ...SUPABASE_VARS])];
  const sources: { where: string; get: (v: string) => string | undefined }[] = [];
  for (const f of ENV_FILES) {
    try {
      const parsed = parseDotenv(await readFile(path.join(root, f), 'utf8'));
      sources.push({ where: f, get: (v) => parsed.get(v) });
    } catch {
      /* missing */
    }
  }
  sources.push({ where: 'the environment', get: (v) => env[v] });
  for (const v of vars) {
    for (const s of sources) {
      const value = s.get(v);
      if (!value) continue;
      let host: string | null = null;
      let local = false;
      const parsed = parseConnectionString(value, { root });
      if (parsed.ok && parsed.target.dialect === 'sqlite') local = true;
      else if (parsed.ok && parsed.target.dialect === 'postgres') {
        host = parsed.target.host;
        local = isLocalHost(parsed.target.host);
      } else {
        host = genericHost(value);
        local = host !== null && isLocalHost(host);
      }
      if (host === null && !local) {
        return { ok: false, reason: `${v} in ${s.where} is set, but holdline can't tell which host it points at, so it won't start the dev server (live mode). Set probes.api.live.allowNonLocalDatabase to true to allow it.` };
      }
      if (!local) {
        return {
          ok: false,
          reason: `${v} in ${s.where} points at ${host}, which is not a local host. Live mode starts your dev server and calls its routes, which could read or write that database. Set probes.api.live.allowNonLocalDatabase to true if that is intended.`,
        };
      }
    }
  }
  return { ok: true };
}

// --- Process handling -------------------------------------------------------------------

const active = new Set<ChildProcess>();
let exitHook = false;

function killGroupSync(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-child.pid, signal);
  } catch {
    /* already gone */
  }
}

function groupAlive(pid: number): boolean {
  if (process.platform === 'win32') {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
  try {
    process.kill(-pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** SIGTERM the whole process group, then SIGKILL whatever is left after a grace period. */
export async function killTree(child: ChildProcess): Promise<void> {
  if (child.pid === undefined) return;
  killGroupSync(child, 'SIGTERM');
  const until = Date.now() + KILL_GRACE_MS;
  while (Date.now() < until && groupAlive(child.pid)) await new Promise((r) => setTimeout(r, 50));
  if (groupAlive(child.pid)) killGroupSync(child, 'SIGKILL');
  const hard = Date.now() + 2000;
  while (Date.now() < hard && groupAlive(child.pid)) await new Promise((r) => setTimeout(r, 25));
  active.delete(child);
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

function tcpOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(500, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

async function devCommand(root: string, pm: PackageManager): Promise<string | null> {
  try {
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    if (pkg.scripts?.dev) return `${pm} run dev`;
  } catch {
    /* no package.json */
  }
  return null;
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

  if (!s.allowNonLocalDatabase) {
    const safety = await databaseSafety(opts.root, opts.dbEnvVar, env);
    if (!safety.ok) return { status: 'refused', message: `live mode not started: ${safety.reason}`, results: [], ms: Date.now() - started };
  }

  const port = await freePort();
  const base = s.command ?? (await devCommand(opts.root, opts.packageManager));
  if (!base) return { status: 'failed', message: 'no "dev" script in package.json; set probes.api.live.command', results: [], ms: Date.now() - started };
  const command = base.replaceAll('{port}', String(port));

  opts.progress?.(`  starting the dev server on port ${port} …`);
  const child = spawn(command, {
    cwd: opts.root,
    shell: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...env, PORT: String(port), BROWSER: 'none', FORCE_COLOR: '0' },
  });
  active.add(child);
  if (!exitHook) {
    exitHook = true;
    process.on('exit', () => {
      for (const c of active) killGroupSync(c, 'SIGKILL');
    });
  }
  const onSignal = (sig: NodeJS.Signals) => {
    for (const c of active) killGroupSync(c, 'SIGKILL');
    process.exit(sig === 'SIGINT' ? 130 : 143);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('SIGHUP', onSignal);

  let exited: number | null | undefined;
  child.once('exit', (code) => (exited = code ?? -1));
  child.once('error', () => (exited = -1));

  try {
    // Wait until the port accepts connections (no HTTP request is made).
    const deadline = Date.now() + s.startupTimeoutSec * 1000;
    let host: string | null = null;
    while (!host) {
      if (opts.signal?.aborted) return { status: 'failed', message: 'cancelled', results: [], ms: Date.now() - started };
      if (exited !== undefined) return { status: 'failed', message: `the dev server (${command}) exited with code ${exited} before it was ready`, results: [], ms: Date.now() - started };
      if (Date.now() > deadline) return { status: 'failed', message: `the dev server did not accept connections on port ${port} within ${s.startupTimeoutSec}s`, results: [], ms: Date.now() - started };
      for (const h of ['127.0.0.1', '::1']) {
        if (await tcpOpen(h, port)) {
          host = h;
          break;
        }
      }
      if (!host) await new Promise((r) => setTimeout(r, 250));
    }
    const origin = `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
    for (const v of valid) {
      if (opts.signal?.aborted) break;
      opts.progress?.(`  calling ${v.method} ${redactPath(v.path)} …`);
      results[v.index] = { ...results[v.index]!, ...(await callOnce(origin, v, s.requestTimeoutSec * 1000, opts.signal)) };
    }
    return { status: 'ok', results, ms: Date.now() - started };
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    process.off('SIGHUP', onSignal);
    await killTree(child);
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
