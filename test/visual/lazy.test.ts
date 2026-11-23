/** Projects without the visual check never load Playwright, pngjs, pixelmatch or the capture code. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { afterCommand } from '../../src/commands/after.js';
import { beforeCommand } from '../../src/commands/before.js';
import { cleanupAll, fakeIo, makeRepo, writeConfig } from '../helpers/tmpRepo.js';

const loaded = vi.hoisted(() => new Set<string>());
vi.mock('../../src/probes/visual/playwright.js', async (orig) => (loaded.add('playwright'), orig()));
vi.mock('../../src/probes/visual/capture.js', async (orig) => (loaded.add('capture'), orig()));
vi.mock('../../src/probes/visual/image.js', async (orig) => (loaded.add('image'), orig()));
vi.mock('../../src/probes/visual/compare.js', async (orig) => (loaded.add('compare'), orig()));
vi.mock('pngjs', async (orig) => (loaded.add('pngjs'), orig()));
vi.mock('pixelmatch', async (orig) => (loaded.add('pixelmatch'), orig()));
vi.mock('playwright', async (orig) => (loaded.add('playwright-pkg'), orig()));

afterEach(cleanupAll);

describe('visual probe when off', () => {
  it('loads nothing', async () => {
    const t = makeRepo();
    t.write('.gitignore', '.holdline/\n');
    t.commitAll('x');
    await writeConfig(t.dir, {}, { probes: { visual: { enabled: false, pages: ['/'] } } });
    const session = await beforeCommand(t.dir, { task: 'x', yes: true }, fakeIo());
    expect(session.probes.visual).toBeUndefined();
    const report = await afterCommand(t.dir, {}, fakeIo());
    expect(report.reports.find((r) => r.probeId === 'visual')).toBeUndefined();
    // Enabled with no pages is off too.
    await writeConfig(t.dir, {}, { probes: { visual: { enabled: true, pages: [] } } });
    await beforeCommand(t.dir, { task: 'x', yes: true }, fakeIo());
    expect([...loaded]).toEqual([]);
  });
});
