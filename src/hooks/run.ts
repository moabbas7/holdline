/**
 * Runs a hook handler with fail-open guarantees: a time budget below Claude Code's own
 * timeout, every error turned into at most one line for the user, nothing on stdout except
 * the JSON Claude Code expects, and (in the CLI) exit code 0 no matter what.
 */
import { spawn } from 'node:child_process';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import { getRepo } from '../core/git.js';
import { stopAllChecks } from '../core/runner.js';
import { allowStarting, stopStarting } from '../core/stop.js';
import { makeColors, type Io } from '../io.js';
import { stopAllDevServers } from '../probes/devServer.js';
import {
  loadConfigOrNull,
  promptHook,
  sessionEndHook,
  sessionStartHook,
  stopHook,
  warmHook,
  type HookContext,
  type HookInput,
  type HookResult,
} from './handlers.js';
import { hookSettings, hooksDisabled } from './settings.js';
import { hooksDir } from './state.js';

export const HOOK_EVENTS = ['session-start', 'prompt', 'stop', 'session-end', 'warm'] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

const HANDLERS: Record<HookEvent, (input: HookInput, ctx: HookContext) => Promise<HookResult>> = {
  'session-start': sessionStartHook,
  prompt: promptHook,
  stop: stopHook,
  'session-end': sessionEndHook,
  warm: warmHook,
};

export interface RunHookOptions {
  env?: NodeJS.ProcessEnv;
  /** Override the time budget (tests). */
  budgetMs?: number;
  spawnWarm?: (root: string, sessionId: string) => void;
  now?: () => number;
  /** Override a handler (tests: crashes). */
  handler?: (input: HookInput, ctx: HookContext) => Promise<HookResult>;
}

export interface RunHookResult {
  /** What to print on stdout ('' or one JSON document). */
  stdout: string;
  result: HookResult;
  ms: number;
}

export const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 400);

/** An Io that records everything (written to .holdline/hooks/<event>.log) and never prompts. */
function recordingIo(): Io & { logs: string[] } {
  const logs: string[] = [];
  return {
    interactive: false,
    c: makeColors(false),
    logs,
    log: (m = '') => void logs.push(m),
    warn: (m) => void logs.push(`warning: ${m}`),
    progress: () => {},
    progressDone: (m) => void logs.push(m),
    confirm: async (_m, d) => d,
    input: async (_m, p) => p,
  };
}

/** Spawn `holdline hook warm` detached, so the SessionStart hook returns at once. */
export function spawnWarmProcess(root: string, sessionId: string): void {
  const cli = process.argv[1];
  if (!cli) return;
  const dir = hooksDir(root);
  let out: number | 'ignore' = 'ignore';
  try {
    mkdirSync(dir, { recursive: true });
    out = openSync(path.join(dir, 'warm.log'), 'w');
  } catch {
    /* no log then */
  }
  const child = spawn(process.execPath, [cli, 'hook', 'warm', '--root', root, '--session', sessionId], {
    cwd: root,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, out],
    env: process.env,
  });
  child.on('error', () => {});
  child.unref();
}

function budgetFor(event: HookEvent, s: ReturnType<typeof hookSettings>): number | null {
  switch (event) {
    case 'prompt':
      return s.promptBudgetSec * 1000;
    case 'stop':
      return s.stopBudgetSec * 1000;
    case 'session-start':
      return 8000;
    case 'session-end':
      return 1200;
    case 'warm':
      return null; // runs in the background, bounded by the checks' own timeouts
  }
}

/**
 * After the budget runs out: the longest holdline waits for what it started to be gone
 * (checks, dev servers, and the abandoned handler, which then releases the lock). It fits in
 * the room hookTimeouts() leaves between the budget and Claude Code's own timeout.
 */
export const WIND_DOWN_MS = 8000;

/**
 * Out of time: stop starting processes, kill what runs, and wait (bounded) until the
 * abandoned work has settled. Only then may processes start again; work that is still
 * going keeps the gate closed (the CLI exits right after anyway).
 */
async function windDown(work: Promise<unknown>): Promise<void> {
  stopStarting();
  const until = Date.now() + WIND_DOWN_MS;
  const left = () => Math.max(0, until - Date.now());
  await stopAllChecks(left());
  await stopAllDevServers(left());
  let timer: NodeJS.Timeout | undefined;
  const settled = await Promise.race([
    work.then(() => true, () => true),
    new Promise<false>((r) => (timer = setTimeout(() => r(false), left()))),
  ]);
  clearTimeout(timer);
  if (settled) allowStarting();
}

const outOfTime = (event: HookEvent, sec: number) =>
  event === 'prompt'
    ? `holdline: recording the baseline took longer than ${sec}s, so this task isn't checked (raise hooks.promptBudgetSec in .holdline/config.json, or speed up the slowest check).`
    : event === 'stop'
      ? `holdline: checking Claude's changes took longer than ${sec}s and was stopped (raise hooks.stopBudgetSec in .holdline/config.json). Run \`holdline after\` yourself.`
      : `holdline: the ${event} hook ran out of time.`;

export async function runHook(event: HookEvent, input: HookInput, opts: RunHookOptions = {}): Promise<RunHookResult> {
  const started = Date.now();
  const env = opts.env ?? process.env;
  let result: HookResult = { outcome: 'noop' };
  let root: string | null = null;
  allowStarting();
  let io: ReturnType<typeof recordingIo> | null = null;
  try {
    if (hooksDisabled(env)) {
      result = { outcome: 'disabled' };
    } else {
      const cwd = (typeof input.cwd === 'string' && input.cwd) || env.CLAUDE_PROJECT_DIR || process.cwd();
      const repo = await getRepo(cwd).catch(() => null);
      if (!repo) {
        result = { outcome: 'not-a-repo' };
      } else {
        root = repo.root;
        const config = await loadConfigOrNull(repo.root);
        const settings = hookSettings(config);
        io = recordingIo();
        let cancelled = false;
        const cancelFns: (() => void)[] = [];
        const ctx: HookContext = {
          repo,
          root: repo.root,
          config,
          settings,
          io,
          now: opts.now ?? Date.now,
          cancelled: () => cancelled,
          onCancel: (fn) => void cancelFns.push(fn),
          spawnWarm: opts.spawnWarm ?? spawnWarmProcess,
        };
        const budget = opts.budgetMs ?? budgetFor(event, settings);
        const work = (opts.handler ?? HANDLERS[event])(input, ctx);
        if (budget === null) {
          result = await work;
        } else {
          let timer: NodeJS.Timeout | undefined;
          const deadline = new Promise<HookResult>((resolve) => {
            timer = setTimeout(() => {
              cancelled = true;
              for (const fn of cancelFns) {
                try {
                  fn();
                } catch {
                  /* best effort */
                }
              }
              resolve({ outcome: 'out-of-time', warning: outOfTime(event, Math.round(budget / 1000)) });
            }, budget);
          });
          work.catch(() => {}); // a late rejection after the deadline is ignored
          try {
            result = await Promise.race([work, deadline]);
          } finally {
            clearTimeout(timer);
          }
          // Out of time: nothing this run started may outlive it (the CLI exits right after).
          if (cancelled) await windDown(work);
        }
      }
    }
  } catch (e) {
    result = { outcome: 'error', warning: `holdline: hook error (${oneLine((e as Error)?.message ?? String(e))}); continuing without it.`, detail: (e as Error)?.stack };
  }

  const ms = Date.now() - started;
  if (root) await writeLogs(root, event, input, result, ms, io?.logs ?? []).catch(() => {});
  return { stdout: formatOutput(result), result, ms };
}

/** Nothing, or one JSON document. Plain text never goes to stdout (UserPromptSubmit would add it to Claude's context). */
export function formatOutput(r: HookResult): string {
  const out: Record<string, unknown> = { ...(r.json ?? {}) };
  if (r.warning && out.systemMessage === undefined) out.systemMessage = oneLine(r.warning);
  return Object.keys(out).length ? JSON.stringify(out) : '';
}

async function writeLogs(root: string, event: HookEvent, input: HookInput, r: HookResult, ms: number, logs: string[]): Promise<void> {
  const dir = hooksDir(root);
  await mkdir(dir, { recursive: true });
  const line = {
    at: new Date().toISOString(),
    event,
    sessionId: input.session_id ?? null,
    ms,
    outcome: r.outcome,
    ...(r.warning ? { warning: oneLine(r.warning) } : {}),
    ...(r.detail ? { detail: r.detail.slice(0, 4000) } : {}),
  };
  await appendFile(path.join(dir, 'log.jsonl'), JSON.stringify(line) + '\n');
  if (logs.length) await writeFile(path.join(dir, `${event}.log`), logs.join('\n') + '\n');
}

/** Read the hook input from stdin (at most `ms`); null when it isn't JSON. */
export async function readHookInput(ms = 2000): Promise<HookInput | null> {
  if (process.stdin.isTTY) return {};
  const chunks: Buffer[] = [];
  const text = await new Promise<string>((resolve) => {
    const done = () => resolve(Buffer.concat(chunks).toString('utf8'));
    const t = setTimeout(done, ms);
    process.stdin.on('data', (d: Buffer) => chunks.push(d));
    process.stdin.on('end', () => {
      clearTimeout(t);
      done();
    });
    process.stdin.on('error', () => {
      clearTimeout(t);
      done();
    });
  });
  process.stdin.pause();
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' ? (v as HookInput) : null;
  } catch {
    return null;
  }
}

/** The CLI entry: `holdline hook <event>`. Always exits 0. */
export async function hookCli(event: string, args: { root?: string; session?: string }): Promise<never> {
  const finish = (stdout: string) => {
    if (stdout) process.stdout.write(stdout + '\n');
    process.exit(0);
  };
  const crash = (e: unknown) => finish(formatOutput({ outcome: 'crash', warning: `holdline: hook crashed (${oneLine((e as Error)?.message ?? String(e))}); continuing without it.` }));
  process.on('uncaughtException', crash);
  process.on('unhandledRejection', crash);
  try {
    if (!(HOOK_EVENTS as readonly string[]).includes(event)) finish(formatOutput({ outcome: 'unknown-event', warning: `holdline: unknown hook "${oneLine(event)}"; run \`holdline install-hooks\` again.` }));
    let input: HookInput | null;
    if (event === 'warm') input = { cwd: args.root, session_id: args.session };
    else input = await readHookInput();
    if (input === null) finish(formatOutput({ outcome: 'bad-input', warning: "holdline: couldn't read the hook input; not checking this time." }));
    const r = await runHook(event as HookEvent, input!);
    finish(r.stdout);
  } catch (e) {
    crash(e);
  }
  // Unreachable: finish() exits.
  return process.exit(0);
}
