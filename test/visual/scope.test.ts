import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { afterCommand } from '../../src/commands/after.js';
import { beforeCommand } from '../../src/commands/before.js';
import { PLAYWRIGHT } from '../helpers/playwright.js';
import { cleanupAll, fakeIo } from '../helpers/tmpRepo.js';
import { addToBody, editPage, visualRepo } from './helpers.js';

afterEach(() => cleanupAll());
const T = 180_000;
const RED_BAR = addToBody('<div style="height:200px;background:#c00"></div>');

describe.skipIf(!PLAYWRIGHT)('visual changes and the task scope', () => {
  it('a visual change on a page outside the task is an "unexpected visual change"; one on the task page is in scope', { timeout: T }, async () => {
    const t = await visualRepo({ pages: ['/', '/layout'] });
    await beforeCommand(t.dir, { task: 'restyle the layout boxes', yes: true }, fakeIo());
    editPage(t, 'layout', RED_BAR);
    editPage(t, 'index', RED_BAR);
    const io = fakeIo();
    const report = await afterCommand(t.dir, {}, io);
    const visual = report.scoped.findings.filter((f) => f.probe === 'visual' && f.images);
    const home = visual.filter((f) => f.pages?.[0] === '/');
    const layout = visual.filter((f) => f.pages?.[0] === '/layout');
    expect(home.length).toBeGreaterThan(0);
    for (const f of home) {
      expect(f.title).toMatch(/^\/ \((desktop|mobile)\): unexpected visual change \(/);
      expect(f.scope).toBe('outside-scope');
      expect(f.kind).toBe('change');
      expect(f.severity).toBe('low');
      expect(f.reason).toBe("page / isn't named by the task");
    }
    for (const f of layout) {
      expect(f.title).toMatch(/looks different/);
      expect(f.scope).toBe('in-scope');
      expect(f.reason).toBe('page /layout matches "layout" in the task');
    }
    expect(report.scoped.exitCode).toBe(0);

    // The HTML report embeds the before/after/diff screenshots.
    const html = readFileSync(t.p(report.scoped.htmlReport!), 'utf8');
    expect(html.match(/src="data:image\/png;base64,/g)!.length).toBeGreaterThanOrEqual(3 * visual.length);
    expect(html).not.toMatch(/https?:\/\//);
  });

  it('probes.visual.failOnUnexpectedChange makes an unexpected visual change a regression', { timeout: T }, async () => {
    const t = await visualRepo({ pages: ['/'], failOnUnexpectedChange: true });
    await beforeCommand(t.dir, { task: 'restyle the layout boxes', yes: true }, fakeIo());
    editPage(t, 'index', RED_BAR);
    const report = await afterCommand(t.dir, {}, fakeIo());
    const f = report.scoped.findings.find((x) => x.probe === 'visual' && x.images)!;
    expect(f.kind).toBe('regression');
    expect(f.severity).toBe('medium');
    expect(f.scope).toBe('outside-scope');
    expect(report.scoped.exitCode).toBe(1);
    expect(report.regressed).toBe(true);
  });
});
