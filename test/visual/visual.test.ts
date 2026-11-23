/**
 * The visual probe against a tiny fixture app (plain Node server): regressions, visual
 * changes, noisy regions, masks, flaky problems and process cleanup.
 */
import { existsSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { afterCommand } from '../../src/commands/after.js';
import { beforeCommand } from '../../src/commands/before.js';
import { readSession } from '../../src/core/session.js';
import { readVisualCapture } from '../../src/probes/visual/index.js';
import type { VisualCapture, VisualRef } from '../../src/probes/visual/types.js';
import { PLAYWRIGHT } from '../helpers/playwright.js';
import { cleanupAll, fakeIo } from '../helpers/tmpRepo.js';
import { addToBody, editPage, expectTreeDead, starts, visualRepo } from './helpers.js';
import { sentinel } from '../helpers/secrets.js';

afterEach(cleanupAll);

const T = 180_000;

const titles = (r: Awaited<ReturnType<typeof afterCommand>>, kind?: string) =>
  r.reports.find((x) => x.probeId === 'visual')!.findings.filter((f) => !kind || f.kind === kind).map((f) => f.title);

describe.skipIf(!PLAYWRIGHT)('visual probe', () => {
  it('reports nothing when nothing changed: live and per-load content is noisy, timestamps are masked', { timeout: T }, async () => {
    const t = await visualRepo({ pages: ['/', '/clock', '/stamp', '/built', '/request', '/nextdev'], mask: ['.ts'] });
    await beforeCommand(t.dir, { task: 'nothing', yes: true }, fakeIo());
    expectTreeDead(t);
    const session = await readSession(t.dir);
    const before = await readVisualCapture(t.dir, session!.probes.visual as VisualRef);
    if (!('capture' in before)) throw new Error(before.error);
    expect(before.capture.status).toBe('ok');
    expect(before.capture.results).toHaveLength(12);
    // The clock changes during a load, the stamp between loads: both are noisy.
    for (const r of before.capture.results.filter((r) => r.page === '/clock' || r.page === '/stamp')) expect(r.noisy?.length).toBeGreaterThan(0);
    for (const r of before.capture.results.filter((r) => r.page !== '/clock' && r.page !== '/stamp')) expect(r.noisy).toBeUndefined();
    for (const r of before.capture.results.filter((r) => r.page === '/built')) expect(r.masked?.length).toBe(1);
    for (const r of before.capture.results) {
      expect(r.load).toMatchObject({ ok: true, status: 200 });
      expect(r.consoleErrors).toEqual([]);
      expect(r.failedRequests).toEqual([]);
      expect(r.blank).toBe(false);
      expect(r.errorScreen).toBeNull();
      expect(existsSync(t.p(r.screenshot!.file))).toBe(true);
    }

    const report = await afterCommand(t.dir, {}, fakeIo());
    expectTreeDead(t);
    const visual = report.reports.find((r) => r.probeId === 'visual')!;
    expect(visual.findings, JSON.stringify(visual.findings)).toEqual([]);
    expect(visual.status).toBe('ok');
    expect(report.regressed).toBe(false);
  });

  it('without the mask, a timestamp that only changes between runs is a visual change', { timeout: T }, async () => {
    const t = await visualRepo({ pages: ['/built'] });
    await beforeCommand(t.dir, { task: 'nothing', yes: true }, fakeIo());
    const report = await afterCommand(t.dir, {}, fakeIo());
    expect(report.regressed).toBe(false);
    const changes = titles(report, 'change');
    expect(changes.some((c) => c.startsWith('/built (desktop): looks different'))).toBe(true);
  });

  it('finds every kind of regression and the layout change', { timeout: T }, async () => {
    const pages = ['/', '/console', '/throw', '/request', '/blank', '/overlay', '/layout', '/servererror'];
    const t = await visualRepo({ pages });
    await beforeCommand(t.dir, { task: 'break things', yes: true }, fakeIo());
    const query = sentinel('query');

    editPage(t, 'console', addToBody(`<script>console.error('Widget failed at ' + location.href + ' ' + Date.now())</script>`));
    editPage(t, 'throw', addToBody(`<script>throw new TypeError('cannot read properties of undefined')</script>`));
    editPage(t, 'request', (h) => h.replace("fetch('/api/ok')", `fetch('/api/missing?token=${query}')`));
    editPage(t, 'blank', () => '<!doctype html><html><head><title>Blank</title></head><body><div id="root"></div></body></html>');
    editPage(
      t,
      'overlay',
      addToBody(`<nextjs-portal></nextjs-portal><script>document.querySelector('nextjs-portal').attachShadow({ mode: 'open' }).innerHTML = '<div data-nextjs-dialog-overlay><div data-nextjs-dialog>Unhandled Runtime Error</div></div>';</script>`),
    );
    editPage(t, 'layout', (h) => h.replace('flex-direction: row', 'flex-direction: column'));
    editPage(t, 'servererror', addToBody('<!-- status:500 -->'));

    const io = fakeIo();
    const report = await afterCommand(t.dir, {}, io);
    expectTreeDead(t);
    expect(report.regressed).toBe(true);
    const visual = report.reports.find((r) => r.probeId === 'visual')!;
    expect(visual.status).toBe('regressed');
    const regs = titles(report, 'regression');
    expect(regs).toContain('/console (desktop, mobile): new console error: Widget failed at /console #');
    expect(regs).toContain('/throw (desktop, mobile): new uncaught error: TypeError: cannot read properties of undefined');
    expect(regs).toContain('/request (desktop, mobile): new failed request: GET /api/missing?token=… → 404');
    expect(regs).toContain('/blank (desktop, mobile): is now blank');
    expect(regs).toContain('/overlay (desktop, mobile): now shows the Next.js error overlay');
    expect(regs).toContain('/servererror (desktop, mobile): no longer loads: HTTP 500');
    expect(regs).toHaveLength(6);
    expect(regs.some((r) => r.startsWith('/ ') || r.startsWith('/layout'))).toBe(false);

    const changes = visual.findings.filter((f) => f.kind === 'change');
    // /request shows "loading" instead of "ok: true" now: also a (correct) visual change.
    expect(changes.map((c) => c.title.replace(/\([^()]*% of pixels changed[^()]*\)/, '(…)'))).toEqual([
      '/request (desktop): looks different (…)',
      '/request (mobile): looks different (…)',
      '/layout (desktop): looks different (…)',
      '/layout (mobile): looks different (…)',
    ]);
    for (const c of changes) {
      const files = c.lines!.map((l) => l.replace(/^\w+:\s+/, ''));
      expect(files[0]).toMatch(/^\.holdline\/visual\/before\/(layout|request)-\w+--(desktop|mobile)\.png$/);
      expect(files[1]).toMatch(/^\.holdline\/visual\/after\//);
      expect(files[2]).toMatch(/^\.holdline\/visual\/diff\//);
      for (const f of files) expect(existsSync(t.p(f))).toBe(true);
    }

    // New problems were confirmed by reloading.
    const afterCap = { capture: JSON.parse(readFileSync(t.p('.holdline/visual/visual-after.json'), 'utf8')) as VisualCapture };
    const thr = afterCap.capture.results.find((r) => r.page === '/throw' && r.viewport === 'desktop')!;
    expect(thr.rechecks).toBe(1);
    expect(afterCap.capture.results.find((r) => r.page === '/')!.rechecks).toBeUndefined();
    // A real visual change shows on every reload.
    expect(afterCap.capture.results.find((r) => r.page === '/layout' && r.viewport === 'desktop')!.rechecks).toBe(2);

    // Query values never stored.
    expect(readFileSync(t.p('.holdline/visual/visual-after.json'), 'utf8')).not.toContain(query);
    expect(io.logs.join('\n')).not.toContain(query);
  });

  it('reports pages that were fixed and problems that are still there', { timeout: T }, async () => {
    const t = await visualRepo({ pages: ['/servererror', '/blank'] });
    editPage(t, 'servererror', addToBody('<!-- status:500 -->'));
    editPage(t, 'blank', () => '<!doctype html><html><body></body></html>');
    await beforeCommand(t.dir, { task: 'fix', yes: true }, fakeIo());
    editPage(t, 'servererror', (h) => h.replace('<!-- status:500 -->', ''));
    const report = await afterCommand(t.dir, {}, fakeIo());
    expect(report.regressed).toBe(false);
    expect(titles(report, 'fixed')).toEqual(['/servererror (desktop, mobile): no longer returns HTTP 500']);
    expect(titles(report, 'still-failing')).toEqual(['/blank (desktop, mobile): still is blank']);
  });

  it('a visual difference that a reload does not show is not reported', { timeout: T }, async () => {
    const t = await visualRepo({ pages: ['/tip'] });
    await beforeCommand(t.dir, { task: 'x', yes: true }, fakeIo());
    t.write('oddload', '');
    const report = await afterCommand(t.dir, {}, fakeIo());
    const visual = report.reports.find((r) => r.probeId === 'visual')!;
    expect(visual.findings.map((f) => [f.kind, f.title])).toEqual([
      ['info', '/tip (desktop, mobile): looked different on one load but a reload matched (content that varies per load); not reported'],
    ]);
    const cap = JSON.parse(readFileSync(t.p('.holdline/visual/visual-after.json'), 'utf8')) as VisualCapture;
    for (const r of cap.results) expect(r).toMatchObject({ variesPerLoad: true, rechecks: 1 });
  });

  it('a page that throws only on its first load is flaky, not a regression', { timeout: T }, async () => {
    const t = await visualRepo({ pages: ['/first-throw'] });
    await beforeCommand(t.dir, { task: 'x', yes: true }, fakeIo());
    editPage(t, 'first-throw', addToBody(FIRST_LOAD_THROW));
    const report = await afterCommand(t.dir, {}, fakeIo());
    expect(report.regressed).toBe(false);
    const visual = report.reports.find((r) => r.probeId === 'visual')!;
    expect(visual.findings.map((f) => [f.kind, f.title, f.lines])).toEqual([
      ['change', '/first-throw (desktop, mobile): flaky: appeared once but not on 2 reloads', ['uncaught error: only on the first load']],
    ]);
  });

  it('errors seen in only one of the two before loads are flaky and never new in after', { timeout: T }, async () => {
    const t = await visualRepo({ pages: ['/first-throw'] });
    editPage(t, 'first-throw', addToBody(FIRST_LOAD_THROW));
    await beforeCommand(t.dir, { task: 'x', yes: true }, fakeIo());
    const session = await readSession(t.dir);
    const before = await readVisualCapture(t.dir, session!.probes.visual as VisualRef);
    if (!('capture' in before)) throw new Error(before.error);
    for (const r of before.capture.results) {
      expect(r.pageErrors).toEqual([]);
      expect(r.flaky?.pageErrors).toEqual(['only on the first load']);
    }
    // The fresh server in `after` throws on the first load again: known, so not new.
    const report = await afterCommand(t.dir, {}, fakeIo());
    const visual = report.reports.find((r) => r.probeId === 'visual')!;
    expect(visual.findings).toEqual([]);
    expect(report.regressed).toBe(false);
  });

  it('starts the dev server once per run when the API live check is also on', { timeout: T }, async () => {
    const t = await visualRepo({ pages: ['/'] }, { api: { enabled: true, live: { enabled: true, requests: [{ path: '/api/ok' }], startupTimeoutSec: 20 } } });
    await beforeCommand(t.dir, { task: 'x', yes: true }, fakeIo());
    expect(starts(t)).toBe(1);
    expectTreeDead(t);
    const report = await afterCommand(t.dir, {}, fakeIo());
    expect(starts(t)).toBe(2);
    expectTreeDead(t);
    expect(report.reports.find((r) => r.probeId === 'visual')!.status).toBe('ok');
    const session = await readSession(t.dir);
    expect((session!.probes.api as { live: string }).live).toBe('ok');
  });

  it('kills the server tree when startup times out', { timeout: T }, async () => {
    const t = await visualRepo({ pages: ['/'], command: 'node hang.cjs', startupTimeoutSec: 2 });
    const io = fakeIo();
    await beforeCommand(t.dir, { task: 'x', yes: true }, io);
    expectTreeDead(t);
    expect(io.warnings.join('\n')).toMatch(/Visual check: the dev server did not accept connections on port \d+ within 2s/);
    const report = await afterCommand(t.dir, {}, fakeIo());
    expect(report.reports.find((r) => r.probeId === 'visual')!.status).toBe('skipped');
    expectTreeDead(t);
  });

  it('discards the results when the dev server exits mid-run', { timeout: T }, async () => {
    const t = await visualRepo({ pages: ['/', '/console'], command: 'node server.cjs --die' });
    const io = fakeIo();
    await beforeCommand(t.dir, { task: 'x', yes: true }, io);
    expectTreeDead(t);
    expect(io.warnings.join('\n')).toContain('Visual check: the dev server (node server.cjs --die) exited with code 3 while pages were being checked, so the results were discarded.');
    const session = await readSession(t.dir);
    expect((session!.probes.visual as VisualRef).status).toBe('failed');
  });

  it('refuses to start the server when the database is not local', { timeout: T }, async () => {
    const t = await visualRepo({ pages: ['/'] });
    const [user, password] = [sentinel('user'), sentinel('password')];
    t.write('.env', `DATABASE_URL=postgres://${user}:${password}@db.prod.example.com/app\n`);
    const io = fakeIo();
    await beforeCommand(t.dir, { task: 'x', yes: true }, io);
    expect(starts(t)).toBe(0);
    const w = io.warnings.join('\n');
    expect(w).toContain('DATABASE_URL in .env points at db.prod.example.com');
    expect(w).toContain('probes.visual.allowNonLocalDatabase');
    expect(w).not.toContain(user);
    expect(w).not.toContain(password);
  });
});

const FIRST_LOAD_THROW = `<script>
const x = new XMLHttpRequest();
x.open('POST', '/count/' + (innerWidth > 800 ? 'desktop' : 'mobile'), false);
x.send();
if (x.responseText === '1') throw new Error('only on the first load');
</script>`;

