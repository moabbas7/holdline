import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { beforeCommand } from '../src/commands/before.js';
import { pruneCommand } from '../src/commands/prune.js';
import { getRepo, type RepoInfo } from '../src/core/git.js';
import { listHistory, pruneHistory } from '../src/core/prune.js';
import { writeRollback, writeSession, type Session } from '../src/core/session.js';
import { historyPrefix, setNamedRef } from '../src/core/snapshot.js';
import { cleanupAll, fakeIo, makeRepo, writeConfig, type TestRepo } from './helpers/tmpRepo.js';

afterEach(cleanupAll);

/**
 * n history entries, each a commit with a distinct tree, written with a single
 * `git fast-import` (one process instead of ~12 per createSnapshot call: spawning git is
 * slow on some machines, and 25 real snapshots took 15 s and timed out under suite load).
 * Ref names follow createSnapshot's `<15-digit ms>-<label>` scheme, oldest first, all
 * before "now" so a real snapshot taken afterwards sorts last. createSnapshot itself is
 * covered by snapshot.test.ts; the last test here takes one real snapshot as well.
 */
function makeHistory(t: TestRepo, repo: RepoInfo, n: number, tag = ''): string[] {
  const base = Date.now() - 1_000_000;
  const refs: string[] = [];
  let stream = '';
  for (let i = 0; i < n; i++) {
    const ref = `${historyPrefix(repo)}${String(base + i).padStart(15, '0')}-test`;
    refs.push(ref);
    const content = `${tag}${i}\n`;
    const msg = `holdline snapshot: test ${i}\n`;
    stream +=
      `commit ${ref}\ncommitter holdline <holdline@localhost> ${Math.floor(base / 1000) + i} +0000\n` +
      `data ${Buffer.byteLength(msg)}\n${msg}M 100644 inline n.txt\ndata ${Buffer.byteLength(content)}\n${content}\n`;
  }
  execFileSync('git', ['fast-import', '--quiet'], { cwd: t.dir, input: stream });
  const shas = new Map(
    t.git('for-each-ref', '--format=%(refname) %(objectname)', historyPrefix(repo))
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split(' ') as [string, string]),
  );
  return refs.map((r) => shas.get(r)!);
}

describe('prune', () => {
  it('keeps only the newest n history refs', async () => {
    const t = makeRepo();
    const repo = await getRepo(t.dir);
    const shas = makeHistory(t, repo, 25);
    expect(await listHistory(repo)).toHaveLength(25);

    const r = await pruneHistory(repo, 20);
    expect(r.deleted).toHaveLength(5);
    const left = await listHistory(repo);
    expect(left.map((e) => e.sha)).toEqual(shas.slice(5));
    // The deleted ones are the oldest.
    expect(r.deleted.map((e) => e.sha)).toEqual(shas.slice(0, 5));
  });

  it('never prunes snapshots used by before, after, pre-rollback, pre-undo, the session or rollback.json', async () => {
    const t = makeRepo();
    const repo = await getRepo(t.dir);
    const shas = makeHistory(t, repo, 12);
    await setNamedRef(repo, 'before', shas[0]!);
    await setNamedRef(repo, 'after', shas[1]!);
    await setNamedRef(repo, 'pre-rollback', shas[2]!);
    await setNamedRef(repo, 'pre-undo', shas[3]!);
    await writeSession(t.dir, { snapshot: { sha: shas[4]! } } as Session);
    await writeRollback(t.dir, {
      version: 1,
      preRollback: shas[5]!,
      rolledBackTo: shas[4]!,
      rolledBackAt: '',
      task: null,
    });

    const dry = await pruneHistory(repo, 1, { dryRun: true });
    expect(dry.deleted).toHaveLength(5);
    expect(await listHistory(repo)).toHaveLength(12);

    const r = await pruneHistory(repo, 1);
    const left = (await listHistory(repo)).map((e) => e.sha);
    expect(left).toEqual([...shas.slice(0, 6), shas[11]]);
    expect(r.protectedKept).toHaveLength(6);
    expect(r.deleted.map((e) => e.sha)).toEqual(shas.slice(6, 11));
    // Named refs are untouched.
    expect(t.refs('refs/holdline/main/').filter((r) => !r.includes('/history/'))).toHaveLength(4);
  });

  it('only touches this worktree\'s namespace', async () => {
    const t = makeRepo();
    const repo = await getRepo(t.dir);
    makeHistory(t, repo, 3);
    const other: RepoInfo = { ...repo, worktreeId: 'wt-other' };
    makeHistory(t, other, 3, 'o');
    await pruneHistory(repo, 0);
    expect(await listHistory(repo)).toHaveLength(0);
    expect(await listHistory(other)).toHaveLength(3);
  });

  it('`holdline before` trims history to 20 automatically', async () => {
    const t = makeRepo();
    // Only the snapshot + prune path matters here; the graph and schema probes are covered elsewhere.
    await writeConfig(t.dir, {}, { probes: { dependencies: { enabled: false }, database: { enabled: false } } });
    t.write('.gitignore', '.holdline/\n');
    const repo = await getRepo(t.dir);
    makeHistory(t, repo, 25);
    const io = fakeIo();
    const session = await beforeCommand(t.dir, { task: 'x', yes: true }, io);
    const left = await listHistory(repo);
    expect(left).toHaveLength(20);
    expect(left.at(-1)!.sha).toBe(session.snapshot.sha);
    expect(io.logs.join('\n')).toMatch(/Pruned 6 old snapshot/);
  });

  it('prune command supports --dry-run and --keep', async () => {
    const t = makeRepo();
    const repo = await getRepo(t.dir);
    makeHistory(t, repo, 4);
    const io = fakeIo();
    const dry = await pruneCommand(t.dir, { keep: 1, dryRun: true }, io);
    expect(dry.deleted).toHaveLength(3);
    expect(await listHistory(repo)).toHaveLength(4);
    expect(io.logs[0]).toMatch(/Would delete 3/);
    await pruneCommand(t.dir, { keep: 1 }, fakeIo());
    expect(await listHistory(repo)).toHaveLength(1);
  });
});
