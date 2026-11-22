import { afterEach, describe, expect, it } from 'vitest';
import { beforeCommand } from '../src/commands/before.js';
import { getRepo } from '../src/core/git.js';
import { largeUntrackedWarning, scanUntracked } from '../src/core/largeFiles.js';
import { cleanupAll, fakeIo, makeRepo, writeConfig } from './helpers/tmpRepo.js';

afterEach(cleanupAll);

const KB = 1024;

describe('large untracked files', () => {
  it('sums untracked, non-ignored files, largest first', async () => {
    const t = makeRepo();
    t.write('.gitignore', 'ignored/\n.holdline/\n');
    t.write('small.txt', 'x'.repeat(10)).write('data/big.bin', Buffer.alloc(50 * KB));
    t.write('ignored/huge.bin', Buffer.alloc(500 * KB)).write('.holdline/x', Buffer.alloc(500 * KB));
    t.write('README.md', 'tracked files do not count'.repeat(1000));
    const scan = await scanUntracked(await getRepo(t.dir));
    expect(scan.files.map((f) => f.path)).toEqual(['data/big.bin', '.gitignore', 'small.txt']);
    expect(scan.totalBytes).toBe(50 * KB + 10 + 'ignored/\n.holdline/\n'.length);
  });

  it('warns above the threshold and lists the biggest files', () => {
    const files = Array.from({ length: 12 }, (_, i) => ({ path: `f${i}.bin`, bytes: (12 - i) * 20 * 1024 * 1024 }));
    const total = files.reduce((s, f) => s + f.bytes, 0);
    const w = largeUntrackedWarning({ totalBytes: total, files }, 100)!;
    expect(w).toMatch(/add up to 1\.5 GB/);
    expect(w).toContain('f0.bin');
    expect(w).toContain('f9.bin');
    expect(w).not.toContain('f10.bin');
    expect(w).toContain('…and 2 more');
    expect(w).toContain('.gitignore');
    expect(largeUntrackedWarning({ totalBytes: 100 * 1024 * 1024, files }, 100)).toBeNull();
  });

  describe('in `holdline before`', () => {
    async function setup() {
      const t = makeRepo();
      t.write('.gitignore', '.holdline/\n');
      await writeConfig(t.dir, {}, { largeUntrackedWarnMB: 0.01 }); // ~10 KB for a fast test
      t.write('dump/export.sql', Buffer.alloc(40 * KB));
      return t;
    }

    it('lets an interactive user cancel, leaving nothing behind', async () => {
      const t = await setup();
      const io = fakeIo({ interactive: true, answers: [false] });
      await expect(beforeCommand(t.dir, { task: 'x' }, io)).rejects.toThrow(/Cancelled/);
      expect(io.warnings.join('\n')).toContain('dump/export.sql');
      expect(t.refs()).toEqual([]);
    });

    it('continues when the user confirms', async () => {
      const t = await setup();
      const io = fakeIo({ interactive: true, answers: [true] });
      await beforeCommand(t.dir, { task: 'x' }, io);
      expect(io.prompts).toHaveLength(1);
      expect(t.refs().length).toBeGreaterThan(0);
    });

    it('continues automatically with --yes, still warning', async () => {
      const t = await setup();
      const io = fakeIo({ interactive: true });
      await beforeCommand(t.dir, { task: 'x', yes: true }, io);
      expect(io.prompts).toHaveLength(0);
      expect(io.warnings.join('\n')).toContain('dump/export.sql');
      expect(t.refs().length).toBeGreaterThan(0);
    });

    it('does not warn once the files are ignored', async () => {
      const t = await setup();
      t.write('.gitignore', '.holdline/\ndump/\n');
      const io = fakeIo({ interactive: true });
      await beforeCommand(t.dir, { task: 'x' }, io);
      expect(io.warnings).toEqual([]);
      expect(io.prompts).toHaveLength(0);
    });
  });
});
