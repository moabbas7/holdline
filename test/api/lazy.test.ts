/**
 * Projects without API routes: the analyser (and the TypeScript program it builds) is never
 * loaded, and the probe adds almost nothing to before/after.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { afterCommand } from '../../src/commands/after.js';
import { beforeCommand } from '../../src/commands/before.js';
import { buildGraph } from '../../src/probes/dependencies/graph.js';
import { captureApi } from '../../src/probes/api/index.js';
import { cleanupAll, fakeIo, makeRepo, writeConfig } from '../helpers/tmpRepo.js';

const loaded = vi.hoisted(() => new Set<string>());
vi.mock('../../src/probes/api/analyse.js', async (importOriginal) => {
  loaded.add('analyse');
  return importOriginal();
});

afterEach(cleanupAll);

describe('api probe on a project without API routes', () => {
  it('is fast and never loads the analyser', async () => {
    const t = makeRepo();
    t.write('.gitignore', '.holdline/\n');
    for (let i = 0; i < 300; i++) {
      t.write(`src/mod${i}.ts`, `import { v${(i + 1) % 300} } from './mod${(i + 1) % 300}';\nexport const v${i} = 1;\nexport async function load${i}() {\n  return fetch('https://api.example.com/x/${i}');\n}\n`);
    }
    t.commitAll('lib');
    await writeConfig(t.dir);
    await beforeCommand(t.dir, { task: 'x', yes: true }, fakeIo());
    t.write('src/mod0.ts', 'export const v0 = 2;\n');
    const report = await afterCommand(t.dir, {}, fakeIo());
    const api = report.reports.find((r) => r.probeId === 'api')!;
    expect(api.status).toBe('skipped');
    expect(api.summary).toBe('no API routes found');

    // With the graph already built (as in before/after), the probe itself is near-instant.
    const graph = await buildGraph(t.dir);
    const started = performance.now();
    const { capture } = await captureApi(t.dir, null, { graph });
    expect(performance.now() - started).toBeLessThan(50);
    expect(capture.stats.routes).toBe(0);
    expect([...loaded]).toEqual([]);
  });
});
