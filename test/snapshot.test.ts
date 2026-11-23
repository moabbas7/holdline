import { afterEach, describe, expect, it } from 'vitest';
import { getRepo } from '../src/core/git.js';
import { createSnapshot, diffSnapshots, readSnapshot, refName } from '../src/core/snapshot.js';
import { ensureGitignore } from '../src/core/store.js';
import { cleanupAll, makeRepo, type TestRepo } from './helpers/tmpRepo.js';
import { WINDOWS } from './helpers/platform.js';

afterEach(cleanupAll);

/** path → content of every file in a snapshot's tree. */
function treeFiles(repo: TestRepo, sha: string): Record<string, string> {
  const out: Record<string, string> = {};
  const names = repo.git('ls-tree', '-r', '--name-only', '-z', `${sha}^{tree}`).split('\0').filter(Boolean);
  for (const n of names) out[n] = repo.git('show', `${sha}:${n}`);
  return out;
}

describe('createSnapshot', () => {
  it('captures a clean tree identical to HEAD', async () => {
    const t = makeRepo();
    const repo = await getRepo(t.dir);
    const snap = await createSnapshot(repo, 'before');
    expect(snap.tree).toBe(t.git('rev-parse', 'HEAD^{tree}').trim());
    expect(snap.head).toBe(t.git('rev-parse', 'HEAD').trim());
    expect(snap.branch).toBe('main');
    expect(t.git('rev-parse', refName(repo, 'before')).trim()).toBe(snap.sha);
    expect(snap.historyRef.startsWith('refs/holdline/main/history/')).toBe(true);
  });

  it('captures modified, deleted and untracked files, and staged vs unstaged content', async () => {
    const t = makeRepo();
    t.write('README.md', 'staged version\n');
    t.git('add', 'README.md');
    t.write('README.md', 'unstaged version\n');
    t.rm('src/index.js');
    t.write('notes/todo.txt', 'untracked\n');
    const repo = await getRepo(t.dir);

    const snap = await createSnapshot(repo, 'before');
    expect(treeFiles(t, snap.sha)).toEqual({
      'README.md': 'unstaged version\n',
      'notes/todo.txt': 'untracked\n',
    });
    const refs = await readSnapshot(repo, snap.sha);
    expect(t.git('show', `${refs.indexTree}:README.md`)).toBe('staged version\n');
    // The deleted file is still in the index (deletion not staged).
    expect(t.git('ls-tree', '--name-only', '-r', refs.indexTree)).toContain('src/index.js');
  });

  it('does not touch HEAD, branch, stash, index or status', async () => {
    const t = makeRepo();
    t.write('README.md', 'staged\n');
    t.git('add', 'README.md');
    t.write('README.md', 'dirty\n').write('new.txt', 'untracked\n').rm('src/index.js');
    const before = {
      head: t.git('rev-parse', 'HEAD'),
      branch: t.git('symbolic-ref', 'HEAD'),
      stash: t.git('stash', 'list'),
      status: t.status(),
      index: t.indexBytes(),
      branches: t.git('for-each-ref', 'refs/heads', 'refs/stash'),
    };
    const files = t.fingerprint();

    await createSnapshot(await getRepo(t.dir), 'before');

    expect(t.git('rev-parse', 'HEAD')).toBe(before.head);
    expect(t.git('symbolic-ref', 'HEAD')).toBe(before.branch);
    expect(t.git('stash', 'list')).toBe('');
    expect(t.git('for-each-ref', 'refs/heads', 'refs/stash')).toBe(before.branches);
    expect(t.indexBytes()!.equals(before.index!)).toBe(true);
    expect(t.status()).toBe(before.status);
    expect(t.fingerprint()).toEqual(files);
  });

  it('works in a repository with no commits', async () => {
    const t = makeRepo({ commit: false });
    t.write('a.txt', 'a\n').write('b/c.txt', 'c\n');
    t.git('add', 'a.txt');
    const repo = await getRepo(t.dir);
    const snap = await createSnapshot(repo, 'before');
    expect(snap.head).toBeNull();
    expect(treeFiles(t, snap.sha)).toEqual({ 'a.txt': 'a\n', 'b/c.txt': 'c\n' });
    const refs = await readSnapshot(repo, snap.sha);
    expect(refs.head).toBeNull();
    expect(t.git('ls-tree', '--name-only', '-r', refs.indexTree).trim()).toBe('a.txt');
  });

  it('works when the repo has no index file at all', async () => {
    const t = makeRepo({ commit: false });
    t.write('only.txt', 'x\n');
    const snap = await createSnapshot(await getRepo(t.dir), 'before');
    expect(treeFiles(t, snap.sha)).toEqual({ 'only.txt': 'x\n' });
  });

  it('skips ignored files and never includes .holdline/', async () => {
    const t = makeRepo();
    t.write('.gitignore', 'node_modules/\n.env\n');
    t.write('node_modules/lib/index.js', 'x').write('.env', 'SECRET=1\n');
    // .holdline is excluded even before it is added to .gitignore.
    t.write('.holdline/session.json', '{}');
    const snap = await createSnapshot(await getRepo(t.dir), 'before');
    const names = Object.keys(treeFiles(t, snap.sha));
    expect(names).not.toContain('.env');
    expect(names.some((n) => n.startsWith('node_modules/'))).toBe(false);
    expect(names.some((n) => n.startsWith('.holdline'))).toBe(false);
    expect(names).toContain('.gitignore');
  });

  it('excludes .holdline/ even if it was committed', async () => {
    const t = makeRepo();
    t.write('.holdline/old.json', '{}');
    t.commitAll('oops');
    const snap = await createSnapshot(await getRepo(t.dir), 'before');
    expect(Object.keys(treeFiles(t, snap.sha)).some((n) => n.startsWith('.holdline'))).toBe(false);
  });

  // Windows has no executable bit (git sets core.filemode=false there).
  it.skipIf(WINDOWS)('records file modes (skipped on Windows: no executable bit)', async () => {
    const t = makeRepo();
    t.write('run.sh', '#!/bin/sh\n').chmod('run.sh', 0o755);
    const snap = await createSnapshot(await getRepo(t.dir), 'before');
    const tree = t.git('ls-tree', '-r', `${snap.sha}^{tree}`);
    expect(tree).toMatch(/^100755 blob \w+\trun\.sh$/m);
  });

  it('records symlinks', async () => {
    const t = makeRepo();
    t.symlink('README.md', 'link.md');
    const snap = await createSnapshot(await getRepo(t.dir), 'before');
    const tree = t.git('ls-tree', '-r', `${snap.sha}^{tree}`);
    expect(tree).toMatch(/^120000 blob \w+\tlink\.md$/m);
  });
});

describe('diffSnapshots', () => {
  it('lists added, modified, deleted and renamed files', async () => {
    const t = makeRepo();
    t.write('big.txt', 'line\n'.repeat(50));
    t.commitAll('big');
    const repo = await getRepo(t.dir);
    const a = await createSnapshot(repo, 'before');
    t.write('README.md', 'changed\n').write('added.txt', 'new\n').rm('src/index.js');
    t.git('mv', 'big.txt', 'moved.txt');
    const b = await createSnapshot(repo, 'after');
    const changes = await diffSnapshots(repo, a.sha, b.sha);
    expect(changes).toEqual(
      expect.arrayContaining([
        { status: 'M', path: 'README.md' },
        { status: 'A', path: 'added.txt' },
        { status: 'D', path: 'src/index.js' },
        { status: 'R', path: 'moved.txt', oldPath: 'big.txt' },
      ]),
    );
    expect(changes).toHaveLength(4);
  });
});

describe('ensureGitignore', () => {
  it('adds .holdline/ exactly once and preserves existing content', async () => {
    const t = makeRepo();
    t.write('.gitignore', 'node_modules/');
    expect(await ensureGitignore(t.dir)).toBe(true);
    expect(await ensureGitignore(t.dir)).toBe(false);
    expect(t.read('.gitignore')).toBe('node_modules/\n.holdline/\n');
  });

  it('creates .gitignore when missing and recognises existing variants', async () => {
    const t = makeRepo();
    expect(await ensureGitignore(t.dir)).toBe(true);
    expect(t.read('.gitignore')).toBe('.holdline/\n');
    t.write('.gitignore', '/.holdline\n');
    expect(await ensureGitignore(t.dir)).toBe(false);
  });
});
