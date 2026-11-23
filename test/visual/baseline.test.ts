/**
 * Reusing a visual baseline: the background run at session start captures pages like `before`
 * (two loads, noise), under .holdline/visual/warm/. A session that reuses it gets its own copy
 * under visual/before/, so a later background run can't change what the session compares to.
 * An `after` capture is never reused for the visual check.
 */
import { existsSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { afterCommand } from '../../src/commands/after.js';
import { readCandidate } from '../../src/core/baseline.js';
import { runHook } from '../../src/hooks/run.js';
import { cleanupAll, fakeIo } from '../helpers/tmpRepo.js';
import { PLAYWRIGHT } from '../helpers/playwright.js';
import { starts, visualRepo } from './helpers.js';

afterEach(() => cleanupAll());

describe.skipIf(!PLAYWRIGHT)('visual baseline reuse', { timeout: 120_000 }, () => {
  it('the warm capture is reused by the first prompt, copied to visual/before, and after captures are not reused', async () => {
    const t = await visualRepo({ pages: ['/'] });
    const w = await runHook('warm', { cwd: t.dir, session_id: 's' });
    expect(w.result.outcome).toBe('baseline-recorded');
    expect(starts(t)).toBe(1);
    expect(existsSync(t.p('.holdline/visual/visual-warm.json'))).toBe(true);
    expect((await readCandidate(t.dir))!.probes.visual).toBeDefined();

    const p = await runHook('prompt', { cwd: t.dir, session_id: 's', prompt: 'change the heading', hook_event_name: 'UserPromptSubmit' }, { spawnWarm: () => {} });
    expect(p.result.outcome).toBe('session-reused-baseline');
    expect(starts(t)).toBe(1); // no new dev server: reused
    const session = JSON.parse(t.read('.holdline/session.json'));
    expect(session.probes.visual.file).toBe('.holdline/visual/visual-before.json');
    const capture = readFileSync(t.p(session.probes.visual.file), 'utf8');
    expect(capture).toContain('.holdline/visual/before/');
    expect(capture).not.toContain('.holdline/visual/warm/');
    const file = (JSON.parse(capture).results[0].screenshot as { file: string }).file;
    expect(file).toMatch(/^\.holdline\/visual\/before\//);
    expect(existsSync(t.p(file))).toBe(true);

    // The after capture of this session is not a visual baseline.
    const report = await afterCommand(t.dir, { noHtml: true }, fakeIo());
    expect(report.scoped.probes.find((x) => x.id === 'visual')!.status).not.toBe('skipped');
    expect((await readCandidate(t.dir))!.probes.visual).toBeUndefined();
  });
});
