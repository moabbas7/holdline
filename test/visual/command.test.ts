/** `holdline visual` on demand, and `holdline init` page suggestions. */
import { afterEach, describe, expect, it } from 'vitest';
import { initCommand } from '../../src/commands/init.js';
import { visualCommand } from '../../src/commands/visual.js';
import { loadConfig } from '../../src/core/config.js';
import { visualProbe } from '../../src/probes/visual/index.js';
import { fixtureRepo } from '../helpers/fixtures.js';
import { PLAYWRIGHT } from '../helpers/playwright.js';
import { cleanupAll, fakeIo } from '../helpers/tmpRepo.js';
import { addToBody, editPage, expectTreeDead, visualRepo } from './helpers.js';

afterEach(cleanupAll);

describe.skipIf(!PLAYWRIGHT)('holdline visual', () => {
  it('prints what each page shows, and the JSON result', { timeout: 120_000 }, async () => {
    const t = await visualRepo({ pages: ['/'] });
    editPage(t, 'console', addToBody(`<script>console.error('bad thing')</script>`));
    const io = fakeIo();
    // Pages on the command line replace the configured ones.
    const r = await visualCommand(t.dir, { pages: ['/console', 'clock', '/missing'] }, io);
    expectTreeDead(t);
    expect(r.status).toBe('ok');
    expect(r.results.map((x) => `${x.page} ${x.viewport}`)).toEqual([
      '/console desktop', '/console mobile', '/clock desktop', '/clock mobile', '/missing desktop', '/missing mobile',
    ]);
    const con = r.results.find((x) => x.page === '/console')!;
    expect(con.consoleErrors).toEqual(['bad thing']);
    expect(con.screenshot!.file).toMatch(/^\.holdline\/visual\/current\/console-\w+--desktop\.png$/);
    expect(r.results.find((x) => x.page === '/missing')!.load).toEqual({ ok: false, status: 404 });
    expect(r.results.find((x) => x.page === '/clock')!.noisy!.length).toBeGreaterThan(0);
    const out = io.logs.join('\n');
    expect(out).toContain('/console (desktop)');
    expect(out).toContain('console error: bad thing');
    expect(out).toContain('/missing (mobile)  HTTP 404');
    expect(out).toContain('changed between two screenshots');

    const json = fakeIo();
    const r2 = await visualCommand(t.dir, { json: true, pages: ['/'] }, json);
    expect(json.logs).toEqual([]);
    expect(JSON.parse(JSON.stringify(r2))).toMatchObject({ status: 'ok', results: [{ page: '/', viewport: 'desktop', blank: false }, { page: '/', viewport: 'mobile' }] });
  });
});

describe('holdline visual without pages', () => {
  it('explains how to list pages', async () => {
    const t = await visualRepo({ enabled: false, pages: [] });
    await expect(visualCommand(t.dir, {}, fakeIo())).rejects.toThrow(/No pages to check/);
    await expect(visualCommand(t.dir, { pages: ['https://evil.example/'] }, fakeIo())).rejects.toThrow(/Not a page path/);
  });
});

describe('init', () => {
  it('suggests static pages from the dependency graph but leaves the check off', async () => {
    const t = fixtureRepo('next-supabase');
    const io = fakeIo();
    await initCommand(t.dir, { yes: true }, io);
    const config = await loadConfig(t.dir);
    expect(config.probes!.visual).toEqual({ enabled: false, pages: ['/', '/users'] });
    expect(visualProbe.enabled(config)).toBe(false);
    expect(io.logs.join('\n')).toContain('Visual check:     off (suggested pages: /, /users)');
  });

  it('enables it only when the user confirms', async () => {
    const t = fixtureRepo('next-supabase');
    await initCommand(t.dir, {}, fakeIo({ interactive: true, answers: [true, false] }));
    expect((await loadConfig(t.dir)).probes!.visual).toEqual({ enabled: false, pages: ['/', '/users'] });
    const t2 = fixtureRepo('next-supabase');
    const io = fakeIo({ interactive: true, answers: [true, true] });
    await initCommand(t2.dir, {}, io);
    expect(io.prompts[1]).toContain('Enable the visual check');
    const config = await loadConfig(t2.dir);
    expect(config.probes!.visual).toEqual({ enabled: true, pages: ['/', '/users'] });
    expect(visualProbe.enabled(config)).toBe(true);
  });
});
