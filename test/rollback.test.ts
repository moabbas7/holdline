import { readdirSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { beforeCommand } from '../src/commands/before.js';
import { rollbackCommand } from '../src/commands/rollback.js';
import { undoRollbackCommand } from '../src/commands/undoRollback.js';
import { getRepo } from '../src/core/git.js';
import { restoreWithSafety } from '../src/core/rollback.js';
import { readRollback } from '../src/core/session.js';
import { createSnapshot, resolveNamedRef } from '../src/core/snapshot.js';
import { cleanupAll, fakeIo, makeRepo, writeConfig, type TestRepo } from './helpers/tmpRepo.js';

afterEach(cleanupAll);

/** A messy "user" state: staged + unstaged edits, untracked work, an unstaged deletion. */
function userWorkInProgress(t: TestRepo): void {
  t.write('.gitignore', 'node_modules/\n.env\n.holdline/\n');
  t.write('docs/guide.md', 'guide v1\n').write('run.sh', '#!/bin/sh\necho hi\n').chmod('run.sh', 0o755);
  t.symlink('README.md', 'link.md');
  t.write('old.txt', 'to be deleted by the user\n');
  t.commitAll('more files');
  t.write('README.md', 'staged edit\n');
  t.git('add', 'README.md');
  t.write('README.md', 'staged edit\nplus unstaged edit\n');
  t.write('drafts/idea.md', 'untracked user work\n');
  t.rm('old.txt');
  t.write('node_modules/pkg/index.js', 'dep v1\n').write('.env', 'KEY=user\n');
}

/** An agent going wild: edits, creates, deletes, swaps file/dir, changes modes, stages. */
function agentChanges(t: TestRepo): void {
  t.write('README.md', 'agent rewrote this\n');
  t.write('src/index.js', 'broken(\n');
  t.write('src/new/deep/feature.ts', 'export {}\n');
  t.write('generated.txt', 'agent output\n');
  t.rm('drafts/idea.md'); // deletes the user's untracked work
  t.rm('docs/guide.md'); // deletes a tracked file; docs/ becomes empty and is removed
  t.chmod('run.sh', 0o644);
  t.rm('link.md').write('link.md', 'now a regular file\n');
  t.write('node_modules/pkg/index.js', 'dep v2\n').write('.env', 'KEY=agent\n');
  t.git('add', 'src/index.js');
}

async function setup(t: TestRepo) {
  await writeConfig(t.dir);
  userWorkInProgress(t);
  const status = t.status();
  const staged = t.staged('README.md');
  const files = t.fingerprint();
  await beforeCommand(t.dir, { task: 'test task', yes: true }, fakeIo());
  return { status, staged, files };
}

const notIgnored = (fp: Record<string, string>) =>
  Object.fromEntries(Object.entries(fp).filter(([k]) => !k.startsWith('node_modules/') && k !== '.env'));

describe('rollback', () => {
  it('restores the exact working tree and staging area from before the agent', async () => {
    const t = makeRepo();
    const before = await setup(t);
    agentChanges(t);

    const outcome = await rollbackCommand(t.dir, { yes: true }, fakeIo());
    expect(outcome).not.toBeNull();

    expect(notIgnored(t.fingerprint())).toEqual(notIgnored(before.files));
    expect(t.status()).toBe(before.status);
    expect(t.staged('README.md')).toBe(before.staged);
    expect(t.read('README.md')).toBe('staged edit\nplus unstaged edit\n');
    expect(t.read('drafts/idea.md')).toBe('untracked user work\n');
    expect(t.exists('old.txt')).toBe(false); // the user's own deletion is kept
    // Created files and the directories that held them are gone.
    expect(t.exists('generated.txt')).toBe(false);
    expect(t.exists('src/new')).toBe(false);
    expect(readdirSync(t.p('src'))).toEqual(['index.js']);
  });

  it('leaves ignored files alone', async () => {
    const t = makeRepo();
    await setup(t);
    agentChanges(t);
    await rollbackCommand(t.dir, { yes: true }, fakeIo());
    expect(t.read('node_modules/pkg/index.js')).toBe('dep v2\n');
    expect(t.read('.env')).toBe('KEY=agent\n');
  });

  it('can be undone, giving back the exact post-agent state', async () => {
    const t = makeRepo();
    await setup(t);
    agentChanges(t);
    const agentFiles = t.fingerprint();
    const agentStatus = t.status();
    const agentStaged = t.staged('src/index.js');

    const rb = await rollbackCommand(t.dir, { yes: true }, fakeIo());
    const record = await readRollback(t.dir);
    expect(record?.preRollback).toBe(rb!.safety.sha);

    await undoRollbackCommand(t.dir, { yes: true }, fakeIo());
    expect(t.fingerprint()).toEqual(agentFiles);
    expect(t.status()).toBe(agentStatus);
    expect(t.staged('src/index.js')).toBe(agentStaged);

    // And the undo itself was snapshotted first.
    const repo = await getRepo(t.dir);
    expect(await resolveNamedRef(repo, 'pre-undo')).toBeTruthy();
  });

  it('rollback → undo → rollback round-trips', async () => {
    const t = makeRepo();
    const before = await setup(t);
    agentChanges(t);
    await rollbackCommand(t.dir, { yes: true }, fakeIo());
    await undoRollbackCommand(t.dir, { yes: true }, fakeIo());
    await rollbackCommand(t.dir, { yes: true }, fakeIo());
    expect(notIgnored(t.fingerprint())).toEqual(notIgnored(before.files));
    expect(t.status()).toBe(before.status);
  });

  it('handles a file replaced by a directory and a directory replaced by a file', async () => {
    const t = makeRepo();
    t.write('config', 'file\n').write('lib/util.js', 'util\n');
    t.commitAll('layout');
    await writeConfig(t.dir);
    const files = t.fingerprint();
    await beforeCommand(t.dir, { task: 'swap', yes: true }, fakeIo());

    t.rm('config').write('config/settings.json', '{}');
    t.rm('lib').write('lib', 'now a file\n');

    await rollbackCommand(t.dir, { yes: true }, fakeIo());
    expect(t.fingerprint()).toEqual({ ...files, '.gitignore': t.fingerprint()['.gitignore']! });
    expect(t.read('config')).toBe('file\n');
    expect(t.read('lib/util.js')).toBe('util\n');
  });

  it('moves an ignored directory that blocks a restored file aside instead of deleting it', async () => {
    const t = makeRepo();
    t.write('.gitignore', 'out/\n.holdline/\n').write('out', 'tracked file named out\n');
    t.commitAll('out file');
    await writeConfig(t.dir);
    await beforeCommand(t.dir, { task: 'x', yes: true }, fakeIo());

    t.rm('out').write('out/build.bin', 'ignored build output'); // out/ is ignored
    const io = fakeIo();
    const outcome = await rollbackCommand(t.dir, { yes: true }, io);

    expect(t.read('out')).toBe('tracked file named out\n');
    expect(outcome!.result.displaced).toHaveLength(1);
    const moved = outcome!.result.displaced[0]!.to;
    expect(t.read(`${moved}/build.bin`)).toBe('ignored build output');
    expect(io.warnings.join('\n')).toContain('Moved out');
  });

  it('restores files when the agent committed, without moving HEAD', async () => {
    const t = makeRepo();
    await writeConfig(t.dir);
    t.write('.gitignore', '.holdline/\n');
    t.commitAll('ignore');
    t.write('wip.txt', 'user wip\n');
    const files = t.fingerprint();
    const status = t.status();
    await beforeCommand(t.dir, { task: 'commit test', yes: true }, fakeIo());

    t.write('README.md', 'agent\n').rm('wip.txt');
    const agentHead = t.commitAll('agent commit');

    const io = fakeIo();
    const outcome = await rollbackCommand(t.dir, { yes: true }, io);
    expect(t.fingerprint()).toEqual(files);
    expect(t.git('rev-parse', 'HEAD').trim()).toBe(agentHead);
    expect(outcome!.headMoved?.currentHead).toBe(agentHead);
    expect(io.warnings.join('\n')).toMatch(/git reset --soft/);
    // Relative to the agent's commit, the restored state shows up as changes; nothing is lost.
    expect(status).toContain('wip.txt');
  });

  it('works in a repository with no commits', async () => {
    const t = makeRepo({ commit: false });
    await writeConfig(t.dir);
    t.write('.gitignore', '.holdline/\n').write('a.txt', 'a\n').write('b.txt', 'b\n');
    t.git('add', 'a.txt');
    const files = t.fingerprint();
    const status = t.status();
    await beforeCommand(t.dir, { task: 'x', yes: true }, fakeIo());
    t.write('a.txt', 'changed').rm('b.txt').write('c.txt', 'new');
    t.git('add', '-A');
    await rollbackCommand(t.dir, { yes: true }, fakeIo());
    expect(t.fingerprint()).toEqual(files);
    expect(t.status()).toBe(status);
  });

  it('cancelling the confirmation changes nothing and keeps the previous safety point', async () => {
    const t = makeRepo();
    await setup(t);
    agentChanges(t);
    const agentFiles = t.fingerprint();
    const io = fakeIo({ interactive: true, answers: [false] });
    await expect(rollbackCommand(t.dir, {}, io)).rejects.toThrow(/Cancelled/);
    expect(t.fingerprint()).toEqual(agentFiles);
    expect(await resolveNamedRef(await getRepo(t.dir), 'pre-rollback')).toBeNull();
    expect(await readRollback(t.dir)).toBeNull();
  });

  it('refuses to run non-interactively without --yes', async () => {
    const t = makeRepo();
    await setup(t);
    agentChanges(t);
    const agentFiles = t.fingerprint();
    await expect(rollbackCommand(t.dir, {}, fakeIo())).rejects.toThrow(/--yes/);
    expect(t.fingerprint()).toEqual(agentFiles);
  });

  it('reports nothing to do when the tree already matches', async () => {
    const t = makeRepo();
    await setup(t);
    const io = fakeIo();
    expect(await rollbackCommand(t.dir, { yes: true }, io)).toBeNull();
    expect(io.logs.join('\n')).toMatch(/Nothing to roll back/);
  });

  it('records the safety snapshot before touching any file', async () => {
    const t = makeRepo();
    const repo = await getRepo(t.dir);
    const target = await createSnapshot(repo, 'before');
    t.write('agent.txt', 'agent work\n');
    let safetyTreeHadAgentFile = false;
    await restoreWithSafety(repo, target.sha, 'pre-rollback', {
      onSafetyRecorded: async (safety) => {
        safetyTreeHadAgentFile = t.git('ls-tree', '--name-only', safety.sha).includes('agent.txt');
        expect(t.exists('agent.txt')).toBe(true); // not yet deleted
      },
    });
    expect(safetyTreeHadAgentFile).toBe(true);
    expect(t.exists('agent.txt')).toBe(false);
  });
});
