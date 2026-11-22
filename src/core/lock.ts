import { randomBytes } from 'node:crypto';
import { unlinkSync, readFileSync } from 'node:fs';
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HoldlineError } from './errors.js';

export interface LockInfo {
  pid: number;
  hostname: string;
  command: string;
  startedAt: string;
  token: string;
}

export const LOCK_FILE = 'lock';

export class LockedError extends HoldlineError {
  constructor(
    public readonly holder: LockInfo,
    lockPath: string,
  ) {
    const where = holder.hostname === os.hostname() ? '' : ` on ${holder.hostname}`;
    super(
      `Another holdline command is running on this project: \`holdline ${holder.command}\` ` +
        `(pid ${holder.pid}${where}, started ${holder.startedAt}). Wait for it to finish. ` +
        `If you are sure it is not running, run \`holdline unlock\` (lock file: ${lockPath}).`,
      3,
    );
    this.name = 'LockedError';
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: exists but owned by someone else.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function parseLock(text: string): LockInfo | null {
  try {
    const v = JSON.parse(text) as Partial<LockInfo>;
    if (typeof v.pid === 'number' && typeof v.hostname === 'string') return v as LockInfo;
  } catch {
    /* corrupt */
  }
  return null;
}

/** Whether an existing lock belongs to a live holdline process. */
export function lockIsLive(info: LockInfo | null): boolean {
  if (!info) return false; // unreadable / corrupt: nobody can own it
  if (info.hostname !== os.hostname()) return true; // can't check another machine's pids
  if (info.pid === process.pid) return true;
  return isProcessAlive(info.pid);
}

export interface HeldLock {
  path: string;
  info: LockInfo;
  release(): Promise<void>;
}

export async function readLock(dir: string): Promise<LockInfo | null | undefined> {
  try {
    return parseLock(await readFile(path.join(dir, LOCK_FILE), 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

/**
 * Take the project lock. The lock file is created atomically via link(2) from a fully
 * written temp file, so other processes never see a half-written lock.
 * A lock left by a process that no longer exists is cleared automatically.
 */
export async function acquireLock(
  dir: string,
  command: string,
  log: (msg: string) => void = () => {},
): Promise<HeldLock> {
  await mkdir(dir, { recursive: true });
  const lockPath = path.join(dir, LOCK_FILE);
  const info: LockInfo = {
    pid: process.pid,
    hostname: os.hostname(),
    command,
    startedAt: new Date().toISOString(),
    token: randomBytes(8).toString('hex'),
  };
  const content = JSON.stringify(info, null, 2) + '\n';
  const tmp = path.join(dir, `${LOCK_FILE}.${process.pid}.${info.token}.tmp`);
  await writeFile(tmp, content);
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await link(tmp, lockPath);
        return {
          path: lockPath,
          info,
          release: async () => releaseIfOurs(lockPath, info.token),
        };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
      let existingText: string;
      try {
        existingText = await readFile(lockPath, 'utf8');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; // released meanwhile
        throw e;
      }
      const existing = parseLock(existingText);
      if (lockIsLive(existing)) throw new LockedError(existing!, lockPath);
      // Stale. Re-check the content right before removing so we never delete a lock
      // that another process just took over.
      let again: string | null = null;
      try {
        again = await readFile(lockPath, 'utf8');
      } catch {
        /* gone already */
      }
      if (again === existingText) {
        await unlink(lockPath).catch(() => {});
        log(
          existing
            ? `Cleared a stale lock left by pid ${existing.pid} (\`holdline ${existing.command}\`), which is no longer running.`
            : 'Cleared an unreadable stale lock file.',
        );
      }
    }
    throw new HoldlineError(`Could not take the lock at ${lockPath}. Try again.`, 3);
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

async function releaseIfOurs(lockPath: string, token: string): Promise<void> {
  try {
    const cur = parseLock(await readFile(lockPath, 'utf8'));
    if (cur?.token === token && cur.pid === process.pid) await unlink(lockPath);
  } catch {
    /* already gone */
  }
}

function releaseIfOursSync(lockPath: string, token: string): void {
  try {
    const cur = parseLock(readFileSync(lockPath, 'utf8'));
    if (cur?.token === token && cur.pid === process.pid) unlinkSync(lockPath);
  } catch {
    /* already gone */
  }
}

/** Run `fn` while holding the project lock; always released, including on Ctrl+C. */
export async function withLock<T>(
  dir: string,
  command: string,
  fn: () => Promise<T>,
  log?: (msg: string) => void,
): Promise<T> {
  const lock = await acquireLock(dir, command, log);
  const onSignal = (signal: NodeJS.Signals) => {
    releaseIfOursSync(lock.path, lock.info.token);
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    return await fn();
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await lock.release();
  }
}
