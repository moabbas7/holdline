import { spawnSync } from 'node:child_process';

/**
 * Kill a process and everything it started.
 *
 * - POSIX: the child was spawned `detached`, so it leads its own process group; signal the
 *   whole group (`-pid`) so grandchildren (npm → node → test workers) don't linger.
 * - Windows: there are no process groups or signals. `taskkill /T /F` ends the whole tree;
 *   `child.kill()` would only end the `cmd.exe` shell and leave its children running.
 *
 * With `waitMs` on Windows, it returns only once every process in the tree is gone (or the
 * wait ran out): taskkill only starts termination, and a process that is still exiting keeps
 * its working folder locked. The wait is synchronous so it also works from a process 'exit'
 * handler. On POSIX, SIGKILL needs no such wait, and a synchronous one couldn't work: the
 * group leader stays a zombie until Node reaps it, which a blocked event loop never does.
 * Async callers wait for the child's 'close' event instead (see runner.stopAllChecks).
 *
 * Errors (the process already exited) are ignored.
 */
export function killProcessTree(pid: number, signal: NodeJS.Signals, opts: { waitMs?: number } = {}): void {
  let pids: number[] = [pid];
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true });
      pids = [pid, ...treePids(r.stdout ?? '')];
    } else {
      process.kill(-pid, signal);
    }
  } catch {
    /* already gone */
  }
  if (opts.waitMs && process.platform === 'win32') waitUntilGone(pids, opts.waitMs);
}

/**
 * The pids taskkill reports ending: "SUCCESS: The process with PID 123 (child process of
 * PID 45) has been terminated." The text is localized, so every number on a line counts:
 * each is either in the tree or its root's parent, which is this process and left out.
 */
export function treePids(taskkillOutput: string, self = process.pid): number[] {
  const out = new Set<number>();
  for (const m of taskkillOutput.matchAll(/\d+/g)) {
    const n = Number(m[0]);
    if (n !== self) out.add(n);
  }
  return [...out];
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function waitUntilGone(pids: number[], ms: number): void {
  const until = Date.now() + ms;
  while (pids.some(processAlive) && Date.now() < until) sleepSync(20);
}
