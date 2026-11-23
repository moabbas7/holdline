import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { killProcessTree } from './processTree.js';
import { assertStarting } from './stop.js';

export interface RunResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  /** Last few KB of combined stdout/stderr. */
  outputTail: string;
}

const TAIL_BYTES = 4096;
const KILL_GRACE_MS = 3000;
/** How long killAllChecks waits for a killed tree to be gone. */
const KILL_WAIT_MS = 5000;

/** Running checks, each with a promise that settles on its 'close'. */
const active = new Map<ChildProcess, Promise<void>>();

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  killProcessTree(child.pid, signal);
}

process.on('exit', () => killAllChecks());

/** SIGKILL every running check's process tree and wait until it is gone (a hook out of time). */
export function killAllChecks(): void {
  for (const child of active.keys()) {
    if (child.pid !== undefined) killProcessTree(child.pid, 'SIGKILL', { waitMs: KILL_WAIT_MS });
  }
}

/**
 * Kill every running check and wait (at most `ms`) until each has closed: 'close' comes
 * after the process exited and every process holding its output pipes did too, so it also
 * covers grandchildren. Returns true when all closed in time.
 */
export async function stopAllChecks(ms = KILL_WAIT_MS): Promise<boolean> {
  const closing = [...active.values()];
  killAllChecks();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((r) => (timer = setTimeout(() => r(false), ms)));
  try {
    return await Promise.race([Promise.all(closing).then(() => true as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run a shell command in `cwd`, streaming combined output to `logFile`.
 * stdin is closed and CI=true is set so test runners don't enter watch/interactive modes.
 */
export async function runCommand(
  command: string,
  opts: { cwd: string; timeoutMs: number; logFile: string },
): Promise<RunResult> {
  assertStarting(`\`${command}\``);
  await mkdir(path.dirname(opts.logFile), { recursive: true });
  const log = createWriteStream(opts.logFile);
  log.write(`$ ${command}\n\n`);
  const started = Date.now();

  return new Promise((resolve, reject) => {
    // Checked again: the gate may have closed while the log folder was being created.
    try {
      assertStarting(`\`${command}\``);
    } catch (e) {
      log.end(() => reject(e));
      return;
    }
    const child = spawn(command, {
      cwd: opts.cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
      env: { ...process.env, CI: 'true', FORCE_COLOR: '0', NO_COLOR: '1' },
    });
    active.set(
      child,
      new Promise<void>((r) => {
        child.once('close', () => r());
        child.once('error', () => r()); // failed to start: there may be no 'close'
      }),
    );
    let tail = Buffer.alloc(0);
    const onData = (d: Buffer) => {
      log.write(d);
      tail = Buffer.concat([tail, d]);
      if (tail.length > TAIL_BYTES * 2) tail = tail.subarray(tail.length - TAIL_BYTES);
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', onData);

    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child, 'SIGTERM');
      killTimer = setTimeout(() => killTree(child, 'SIGKILL'), KILL_GRACE_MS);
    }, opts.timeoutMs);

    let done = false;
    const finish = (exitCode: number | null, signal: string | null, extra?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      active.delete(child);
      const durationMs = Date.now() - started;
      let outputTail = tail.subarray(Math.max(0, tail.length - TAIL_BYTES)).toString('utf8');
      if (extra) outputTail += `\n${extra}`;
      if (timedOut) outputTail += `\n[holdline] timed out after ${Math.round(opts.timeoutMs / 1000)}s`;
      log.end(`\n[holdline] exit=${exitCode} signal=${signal} timedOut=${timedOut} ${durationMs}ms\n`, () =>
        resolve({ exitCode, signal, timedOut, durationMs, outputTail }),
      );
    };
    child.on('error', (e) => finish(null, null, `[holdline] failed to start: ${e.message}`));
    child.on('close', (code, signal) => finish(code, signal));
  });
}
