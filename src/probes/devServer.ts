/**
 * Dev server handling shared by the probes that need a running app (API live mode, visual).
 *
 * Safety: refuses to start when a database URL the server would see points at a non-local
 * host (unless allowed); runs on a free port in its own process group; readiness is a TCP
 * connect, not an HTTP call; the whole process tree is always killed, including on errors,
 * startup timeouts and Ctrl+C. A DevServerPool starts each server once per run, so several
 * probes in one `before`/`after` share it.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import type { PackageManager } from '../core/config.js';
import { killProcessTree } from '../core/processTree.js';
import { assertStarting } from '../core/stop.js';
import { DEFAULT_ENV_VARS, ENV_FILES, parseDotenv } from './database/live/env.js';
import { isLocalHost, parseConnectionString } from './database/live/target.js';
import { agree } from '../plural.js';

const SUPABASE_VARS = ['SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL'];
const KILL_GRACE_MS = 3000;
const TAIL_BYTES = 16 * 1024;

// --- Next.js stopping its dev server for AI agents ------------------------------------------

/**
 * Environment variables that tell tools an AI agent is running (the names @vercel/detect-agent,
 * which Next.js uses, looks for). holdline runs inside the agent's environment when it runs
 * from a hook, so the dev server sees them too. holdline never hides or changes them.
 */
export const AGENT_ENV_VARS = [
  'AI_AGENT',
  'CLAUDECODE',
  'CLAUDE_CODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CURSOR_AGENT',
  'CURSOR_TRACE_ID',
  'CODEX_SANDBOX',
  'CODEX_THREAD_ID',
  'CODEX_CI',
  'GEMINI_CLI',
  'OPENCODE',
  'AUGMENT_AGENT',
  'ANTIGRAVITY_AGENT',
  'REPL_ID',
];

export const agentVarsIn = (env: NodeJS.ProcessEnv) => AGENT_ENV_VARS.filter((v) => env[v] !== undefined && env[v] !== '');

const NEXT_AGENT_STOP = /This command stopped to show the upgrade recommendation|UpgradeNudgeError|SecurityFatalError/;

/**
 * Next.js 16.4+ stops `next dev` (exit code 1) when it detects an AI agent and the project
 * sets `experimental.agentUpgrade`: it prints an upgrade recommendation for the agent instead
 * of starting. Returns the explanation, or null when the output isn't that.
 */
export function nextAgentStopMessage(output: string, env: NodeJS.ProcessEnv): string | null {
  if (!NEXT_AGENT_STOP.test(output)) return null;
  const clean = output.replace(/\x1b\[[0-9;]*m/g, '');
  const summary =
    /Next\.js [\w.-]+ is available\. You're using [\w.-]+\./.exec(clean)?.[0] ??
    (/affected by a known security vulnerability/.test(clean) ? 'Your version of Next.js is affected by a known security vulnerability.' : null) ??
    (/includes Future Defaults/.test(clean) ? 'Next.js recommends adopting its Future Defaults.' : null);
  const vars = agentVarsIn(env);
  return (
    `Next.js stopped \`next dev\` before it started: it detected an AI agent${vars.length ? ` (${vars.join(', ')} ${agree(vars.length, 'is', 'are')} set)` : ''} ` +
    `and the project sets experimental.agentUpgrade, so it shows an upgrade recommendation instead${summary ? ` ("${summary}")` : ''}. ` +
    'holdline does not hide agent variables or retry around this, so this check was skipped. To run it: upgrade Next.js (npx next upgrade), ' +
    'remove experimental.agentUpgrade from next.config, or run `holdline before`/`holdline after` from a terminal outside the agent.'
  );
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
 * `settingKey` is the config setting that allows it (shown in the message).
 */
export async function databaseSafety(
  root: string,
  extraVar: string | undefined,
  env: NodeJS.ProcessEnv,
  settingKey = 'probes.api.live.allowNonLocalDatabase',
  what = 'live mode',
): Promise<SafetyResult> {
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
        return { ok: false, reason: `${v} in ${s.where} is set, but holdline can't tell which host it points at, so it won't start the dev server (${what}). Set ${settingKey} to true to allow it.` };
      }
      if (!local) {
        return {
          ok: false,
          reason: `${v} in ${s.where} points at ${host}, which is not a local host. ${what[0]!.toUpperCase()}${what.slice(1)} starts your dev server and uses its pages and routes, which could read or write that database. Set ${settingKey} to true if that is intended.`,
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
  killProcessTree(child.pid, signal);
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

export async function devCommand(root: string, pm: PackageManager): Promise<string | null> {
  try {
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    if (pkg.scripts?.dev) return `${pm} run dev`;
  } catch {
    /* no package.json */
  }
  return null;
}

/** SIGKILL every running dev server's process tree and wait until it is gone (a hook out of time). */
export function killAllDevServers(): void {
  for (const c of active) {
    if (c.pid !== undefined) killProcessTree(c.pid, 'SIGKILL', { waitMs: 5000 });
  }
}

/** Kill every running dev server and wait (at most `ms`) until each process tree is gone. */
export async function stopAllDevServers(ms = 5000): Promise<boolean> {
  const servers = [...active].filter((c) => c.pid !== undefined);
  killAllDevServers();
  const until = Date.now() + ms;
  while (servers.some((c) => groupAlive(c.pid!)) && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
  for (const c of servers) if (!groupAlive(c.pid!)) active.delete(c);
  return !servers.some((c) => groupAlive(c.pid!));
}

// Signal handlers are installed while at least one server is running.
let signalHandlersInstalled = 0;
const onSignal = (sig: NodeJS.Signals) => {
  for (const c of active) killGroupSync(c, 'SIGKILL');
  process.exit(sig === 'SIGINT' ? 130 : 143);
};
function installSignalHandlers(): void {
  if (signalHandlersInstalled++ > 0) return;
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('SIGHUP', onSignal);
}
function removeSignalHandlers(): void {
  if (--signalHandlersInstalled > 0) return;
  signalHandlersInstalled = 0;
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  process.off('SIGHUP', onSignal);
}

export interface StartOptions {
  root: string;
  /** Command to run; `{port}` is replaced. Default: `<pm> run dev` when package.json has a dev script. */
  command?: string;
  packageManager: PackageManager;
  startupTimeoutSec: number;
  /** Setting to name when no command is found (e.g. probes.api.live.command). */
  commandSetting?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  progress?: (msg: string) => void;
  /** Where the server's output goes (default: discarded, except the last few KB kept in memory). */
  logFile?: string;
}

export interface RunningServer {
  ok: true;
  origin: string;
  port: number;
  command: string;
  /** Exit code if the server process has exited since it became ready, else undefined. */
  exited(): number | undefined;
  /** Kill the whole process tree. Safe to call more than once. */
  stop(): Promise<void>;
}
/** `skipped`: the server stopped itself on purpose (Next.js's agent upgrade stop); not a holdline or app failure. */
export type ServerFailure = { ok: false; status: 'failed' | 'refused' | 'skipped'; message: string };
export type StartResult = RunningServer | ServerFailure;

/** Start a dev server on a free port and wait until it accepts TCP connections. */
export async function startDevServer(opts: StartOptions): Promise<StartResult> {
  const env = opts.env ?? process.env;
  const port = await freePort();
  const base = opts.command ?? (await devCommand(opts.root, opts.packageManager));
  if (!base) return { ok: false, status: 'failed', message: `no "dev" script in package.json; set ${opts.commandSetting ?? 'a command'}` };
  const command = base.replaceAll('{port}', String(port));

  opts.progress?.(`  starting the dev server on port ${port} …`);
  assertStarting('the dev server');
  const child = spawn(command, {
    cwd: opts.root,
    shell: true,
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...env, PORT: String(port), BROWSER: 'none', FORCE_COLOR: '0' },
  });
  active.add(child);
  // Keep reading the output (a full pipe would stall the server); keep the end in memory.
  let tail = Buffer.alloc(0);
  let log: WriteStream | null = null;
  if (opts.logFile) {
    try {
      mkdirSync(path.dirname(opts.logFile), { recursive: true });
      log = createWriteStream(opts.logFile);
      log.on('error', () => (log = null));
    } catch {
      log = null;
    }
  }
  const onData = (d: Buffer) => {
    log?.write(d);
    tail = Buffer.concat([tail, d]);
    if (tail.length > TAIL_BYTES * 2) tail = tail.subarray(tail.length - TAIL_BYTES);
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  const output = () => tail.toString('utf8');
  if (!exitHook) {
    exitHook = true;
    process.on('exit', () => {
      for (const c of active) killGroupSync(c, 'SIGKILL');
    });
  }
  installSignalHandlers();
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    try {
      await killTree(child);
    } finally {
      removeSignalHandlers();
      log?.end();
    }
  };

  let exited: number | null | undefined;
  child.once('exit', (code) => (exited = code ?? -1));
  child.once('error', () => (exited = -1));

  try {
    const deadline = Date.now() + opts.startupTimeoutSec * 1000;
    let host: string | null = null;
    while (!host) {
      if (opts.signal?.aborted) throw new StartFailure('cancelled');
      if (exited !== undefined) {
        // Let the last output arrive before reading it.
        await new Promise((r) => setTimeout(r, 100));
        const why = nextAgentStopMessage(output(), env);
        if (why) throw new StartSkipped(why);
        throw new StartFailure(`the dev server (${command}) exited with code ${exited} before it was ready`);
      }
      if (Date.now() > deadline) throw new StartFailure(`the dev server did not accept connections on port ${port} within ${opts.startupTimeoutSec}s`);
      for (const h of ['127.0.0.1', '::1']) {
        if (await tcpOpen(h, port)) {
          host = h;
          break;
        }
      }
      if (!host) await new Promise((r) => setTimeout(r, 250));
    }
    const origin = `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
    return { ok: true, origin, port, command, stop, exited: () => (stopped ? undefined : (exited ?? undefined)) };
  } catch (e) {
    await stop();
    if (e instanceof StartSkipped) return { ok: false, status: 'skipped', message: e.message };
    if (e instanceof StartFailure) return { ok: false, status: 'failed', message: e.message };
    return { ok: false, status: 'failed', message: `the dev server could not be started: ${(e as Error).message}` };
  }
}

class StartFailure extends Error {}
class StartSkipped extends Error {}

// --- Pool ---------------------------------------------------------------------------------

export interface AcquireOptions extends StartOptions {
  allowNonLocalDatabase: boolean;
  /** probes.database.envVar */
  dbEnvVar?: string;
  /** Setting that allows a non-local database (named in the refusal). */
  settingKey: string;
  /** What is starting the server, for messages ("live mode", "the visual check"). */
  what: string;
}

/**
 * One per `before`/`after` (or on-demand command) run. The first probe that needs a server
 * starts it; later probes with the same command reuse it, and a failed start is not retried.
 * dispose() kills everything; callers must always call it (try/finally).
 */
export class DevServerPool {
  private servers = new Map<string, Promise<StartResult>>();
  /** How many servers were actually started (for tests). */
  started = 0;

  async acquire(opts: AcquireOptions): Promise<StartResult> {
    const env = opts.env ?? process.env;
    // The safety check runs for every caller, with that caller's own setting.
    if (!opts.allowNonLocalDatabase) {
      const safety = await databaseSafety(opts.root, opts.dbEnvVar, env, opts.settingKey, opts.what);
      if (!safety.ok) return { ok: false, status: 'refused', message: `${opts.what} not started: ${safety.reason}` };
    }
    const key = `${opts.root}\0${opts.command ?? (await devCommand(opts.root, opts.packageManager)) ?? ''}`;
    let p = this.servers.get(key);
    if (!p) {
      this.started++;
      p = startDevServer(opts);
      this.servers.set(key, p);
    } else {
      opts.progress?.('  reusing the dev server …');
    }
    return p;
  }

  async dispose(): Promise<void> {
    const all = [...this.servers.values()];
    this.servers.clear();
    for (const p of all) {
      const r = await p;
      if (r.ok) await r.stop();
    }
  }
}
