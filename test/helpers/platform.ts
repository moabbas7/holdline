/**
 * Platform switches for tests that can't run everywhere. A test that can't run on a platform
 * is skipped there with the reason in its title, never deleted.
 */
export const WINDOWS = process.platform === 'win32';

/** Is a process still running? */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
