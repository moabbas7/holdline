import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { beforeCommand } from '../src/commands/before.js';
import { unlockCommand } from '../src/commands/unlock.js';
import { acquireLock, LockedError, withLock } from '../src/core/lock.js';
import { cleanupAll, fakeIo, makeRepo, tmpDir, writeConfig } from './helpers/tmpRepo.js';

const children: ReturnType<typeof spawn>[] = [];
afterEach(() => {
  for (const c of children.splice(0)) c.kill('SIGKILL');
  cleanupAll();
});

function writeLock(dir: string, pid: number, extra: object = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'lock'),
    JSON.stringify({ pid, hostname: os.hostname(), command: 'before', startedAt: new Date().toISOString(), token: 'x', ...extra }),
  );
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '']);
  await new Promise((r) => child.on('exit', r));
  return child.pid!;
}

function livePid(): number {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
  children.push(child);
  return child.pid!;
}

describe('lock', () => {
  it('refuses to run while another live holdline process holds the lock', async () => {
    const t = makeRepo();
    await writeConfig(t.dir);
    const pid = livePid();
    writeLock(path.join(t.dir, '.holdline'), pid);

    const err = await beforeCommand(t.dir, { task: 'x', yes: true }, fakeIo()).catch((e) => e);
    expect(err).toBeInstanceOf(LockedError);
    expect(String(err.message)).toContain(`pid ${pid}`);
    // The live lock is left in place, and nothing was snapshotted.
    expect(JSON.parse(readFileSync(path.join(t.dir, '.holdline/lock'), 'utf8')).pid).toBe(pid);
    expect(t.refs()).toEqual([]);
  });

  it('clears a stale lock from a process that is no longer running', async () => {
    const t = makeRepo();
    await writeConfig(t.dir);
    const pid = await deadPid();
    writeLock(path.join(t.dir, '.holdline'), pid);

    const io = fakeIo();
    await beforeCommand(t.dir, { task: 'x', yes: true }, io);
    expect(io.warnings.join('\n')).toMatch(new RegExp(`stale lock left by pid ${pid}`));
    expect(existsSync(path.join(t.dir, '.holdline/lock'))).toBe(false);
    expect(t.refs().length).toBeGreaterThan(0);
  });

  it('treats a corrupt lock file as stale', async () => {
    const dir = tmpDir();
    writeFileSync(path.join(dir, 'lock'), '{not json');
    const lock = await acquireLock(dir, 'test');
    await lock.release();
    expect(existsSync(path.join(dir, 'lock'))).toBe(false);
  });

  it('treats a lock from another machine as live', async () => {
    const dir = tmpDir();
    writeLock(dir, 1, { hostname: 'some-other-host' });
    await expect(acquireLock(dir, 'test')).rejects.toBeInstanceOf(LockedError);
  });

  it('releases the lock after success and after an error', async () => {
    const dir = tmpDir();
    await withLock(dir, 'ok', async () => {
      expect(existsSync(path.join(dir, 'lock'))).toBe(true);
    });
    expect(existsSync(path.join(dir, 'lock'))).toBe(false);
    await expect(withLock(dir, 'boom', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(existsSync(path.join(dir, 'lock'))).toBe(false);
  });

  it('allows only one of two concurrent acquirers', async () => {
    const dir = tmpDir();
    const results = await Promise.allSettled([acquireLock(dir, 'a'), acquireLock(dir, 'b')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });

  it('unlock refuses to remove a live lock but removes a dead one', async () => {
    const t = makeRepo();
    const dir = path.join(t.dir, '.holdline');
    writeLock(dir, livePid());
    await expect(unlockCommand(t.dir, { yes: true }, fakeIo())).rejects.toThrow(/still running/);
    writeLock(dir, await deadPid());
    expect(await unlockCommand(t.dir, { yes: true }, fakeIo())).toBe(true);
    expect(existsSync(path.join(dir, 'lock'))).toBe(false);
  });
});
