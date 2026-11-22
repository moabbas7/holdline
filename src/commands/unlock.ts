import { unlink } from 'node:fs/promises';
import os from 'node:os';
import { HoldlineError } from '../core/errors.js';
import { isProcessAlive, readLock } from '../core/lock.js';
import type { Io } from '../io.js';
import { openProject, requireConfirmation } from './common.js';

export async function unlockCommand(cwd: string, opts: { yes?: boolean }, io: Io): Promise<boolean> {
  const { paths } = await openProject(cwd);
  const info = await readLock(paths.dir);
  if (info === undefined) {
    io.log('No lock is held.');
    return false;
  }
  if (info && info.hostname === os.hostname() && isProcessAlive(info.pid) && info.pid !== process.pid) {
    throw new HoldlineError(
      `\`holdline ${info.command}\` (pid ${info.pid}) is still running. Stop it first; it releases the lock on exit.`,
    );
  }
  const who = info ? `\`holdline ${info.command}\` (pid ${info.pid} on ${info.hostname}, ${info.startedAt})` : 'an unreadable lock';
  if (!(await requireConfirmation(io, `Remove the lock held by ${who}?`, { yes: opts.yes }))) return false;
  await unlink(paths.lock).catch(() => {});
  io.log('Lock removed.');
  return true;
}
