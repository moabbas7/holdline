import { spawnSync } from 'node:child_process';

/**
 * Kill a process and everything it started.
 *
 * - POSIX: the child was spawned `detached`, so it leads its own process group; signal the
 *   whole group (`-pid`) so grandchildren (npm → node → test workers) don't linger.
 * - Windows: there are no process groups or signals. `taskkill /T /F` ends the whole tree;
 *   `child.kill()` would only end the `cmd.exe` shell and leave its children running.
 *
 * Errors (the process already exited) are ignored.
 */
export function killProcessTree(pid: number, signal: NodeJS.Signals): void {
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(-pid, signal);
    }
  } catch {
    /* already gone */
  }
}
