import { existsSync, lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { beforeCommand } from '../src/commands/before.js';
import { rollbackCommand } from '../src/commands/rollback.js';
import { undoRollbackCommand } from '../src/commands/undoRollback.js';
import { git } from '../src/core/git.js';
import { getRepo } from '../src/core/git.js';
import { readSession } from '../src/core/session.js';
import { createSnapshot, refName, withTempIndex } from '../src/core/snapshot.js';
import { cleanupAll, fakeIo, makeRepo, tmpDir, TestRepo, writeConfig } from './helpers/tmpRepo.js';

afterEach(cleanupAll);

function makeWorktree(): { main: TestRepo; wt: TestRepo } {
  const main = makeRepo();
  main.write('.gitignore', '.holdline/\n');
  main.commitAll('ignore');
  const wtDir = path.join(tmpDir('holdline-wt-'), 'feature');
  main.git('worktree', 'add', '-q', '-b', 'feature', wtDir);
  return { main, wt: new TestRepo(wtDir) };
}

const tempIndexFiles = (dir: string) => readdirSync(dir).filter((f) => f.startsWith('holdline-index-'));

describe('git worktrees', () => {
  it('detects a linked worktree whose .git is a file', async () => {
    const { main, wt } = makeWorktree();
    expect(lstatSync(wt.p('.git')).isFile()).toBe(true);
    const repo = await getRepo(wt.dir);
    expect(repo.isLinkedWorktree).toBe(true);
    expect(repo.worktreeId).toMatch(/^wt-[0-9a-f]{12}$/);
    expect(repo.gitDir).toBe(wt.gitDir());
    expect(repo.gitDir.startsWith(path.join(main.gitDir(), 'worktrees'))).toBe(true);
    expect((await getRepo(main.dir)).worktreeId).toBe('main');
  });

  it('puts the temp index in the worktree git dir and always removes it', async () => {
    const { wt } = makeWorktree();
    const repo = await getRepo(wt.dir);
    let seenPath = '';
    await withTempIndex(repo, async (env) => {
      await git(['read-tree', 'HEAD'], { cwd: repo.root, env });
      seenPath = env.GIT_INDEX_FILE;
      expect(existsSync(seenPath)).toBe(true);
    });
    expect(path.dirname(seenPath)).toBe(repo.gitDir);
    expect(existsSync(seenPath)).toBe(false);

    // On error too.
    await expect(
      withTempIndex(repo, async (env) => {
        await git(['read-tree', 'HEAD'], { cwd: repo.root, env });
        await git(['read-tree', 'not-a-real-tree'], { cwd: repo.root, env });
      }),
    ).rejects.toThrow();
    expect(tempIndexFiles(repo.gitDir)).toEqual([]);
  });

  it('uses unique temp index names', async () => {
    const t = makeRepo();
    const repo = await getRepo(t.dir);
    const names = new Set<string>();
    await Promise.all(
      Array.from({ length: 5 }, () => withTempIndex(repo, async (env) => void names.add(env.GIT_INDEX_FILE))),
    );
    expect(names.size).toBe(5);
    expect(tempIndexFiles(repo.gitDir)).toEqual([]);
  });

  it('leaves no temp index behind when a snapshot fails', async () => {
    const t = makeRepo();
    t.write('secret.txt', 'x').chmod('secret.txt', 0o000); // unreadable → git add fails
    const repo = await getRepo(t.dir);
    try {
      await expect(createSnapshot(repo, 'before')).rejects.toThrow();
    } finally {
      t.chmod('secret.txt', 0o644);
    }
    expect(tempIndexFiles(repo.gitDir)).toEqual([]);
  });

  it('snapshots, rolls back and undoes inside a linked worktree', async () => {
    const { main, wt } = makeWorktree();
    await writeConfig(wt.dir);
    wt.write('README.md', 'worktree wip\n').write('wip.txt', 'untracked\n');
    wt.git('add', 'README.md');
    const files = wt.fingerprint();
    const status = wt.status();
    const mainFiles = main.fingerprint();

    await beforeCommand(wt.dir, { task: 'wt task', yes: true }, fakeIo());
    wt.write('src/index.js', 'agent\n').write('agent/new.ts', 'x').rm('wip.txt');
    const agentFiles = wt.fingerprint();

    await rollbackCommand(wt.dir, { yes: true }, fakeIo());
    expect(wt.fingerprint()).toEqual(files);
    expect(wt.status()).toBe(status);

    await undoRollbackCommand(wt.dir, { yes: true }, fakeIo());
    expect(wt.fingerprint()).toEqual(agentFiles);

    expect(main.fingerprint()).toEqual(mainFiles);
    expect(tempIndexFiles(wt.gitDir())).toEqual([]);
    expect(tempIndexFiles(main.gitDir())).toEqual([]);
  });

  it('keeps sessions and refs of different worktrees separate', async () => {
    const { main, wt } = makeWorktree();
    await writeConfig(main.dir);
    await writeConfig(wt.dir);
    main.write('main-only.txt', 'main\n');
    wt.write('wt-only.txt', 'wt\n');

    const s1 = await beforeCommand(main.dir, { task: 'main task', yes: true }, fakeIo());
    const s2 = await beforeCommand(wt.dir, { task: 'wt task', yes: true }, fakeIo());
    expect(s1.snapshot.sha).not.toBe(s2.snapshot.sha);

    const mainRepo = await getRepo(main.dir);
    const wtRepo = await getRepo(wt.dir);
    expect(main.git('rev-parse', refName(mainRepo, 'before')).trim()).toBe(s1.snapshot.sha);
    expect(main.git('rev-parse', refName(wtRepo, 'before')).trim()).toBe(s2.snapshot.sha);
    expect((await readSession(main.dir))!.task).toBe('main task');
    expect((await readSession(wt.dir))!.task).toBe('wt task');

    // Rolling back the worktree does not affect the main checkout.
    wt.write('agent.txt', 'x');
    main.write('main-agent.txt', 'y');
    await rollbackCommand(wt.dir, { yes: true }, fakeIo());
    expect(wt.exists('agent.txt')).toBe(false);
    expect(main.exists('main-agent.txt')).toBe(true);
  });
});
