import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

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

const active = new Set<ChildProcess>();

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    // Detached children lead their own process group: kill the whole group so
    // grandchildren (npm → node → jest workers) don't linger.
    if (process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    /* already exited */
  }
}

process.on('exit', () => {
  for (const child of active) killTree(child, 'SIGKILL');
});

/**
 * Run a shell command in `cwd`, streaming combined output to `logFile`.
 * stdin is closed and CI=true is set so test runners don't enter watch/interactive modes.
 */
export async function runCommand(
  command: string,
  opts: { cwd: string; timeoutMs: number; logFile: string },
): Promise<RunResult> {
  await mkdir(path.dirname(opts.logFile), { recursive: true });
  const log = createWriteStream(opts.logFile);
  log.write(`$ ${command}\n\n`);
  const started = Date.now();

  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: opts.cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      env: { ...process.env, CI: 'true', FORCE_COLOR: '0', NO_COLOR: '1' },
    });
    active.add(child);
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
