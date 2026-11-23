import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { confirmNew, isOwnOrigin, loadStorageState, mergeBeforeLoads, normaliseMessage, normalisePath, pageSlug } from '../../src/probes/visual/capture.js';
import { compareVisual } from '../../src/probes/visual/compare.js';
import { diffImages, isSingleColour, noisyRegions, type Img } from '../../src/probes/visual/image.js';
import { visualSettings, type PageResult, type PageSignals, type VisualCapture } from '../../src/probes/visual/types.js';
import { tmpDir } from '../helpers/tmpRepo.js';

function img(w: number, h: number, fill: [number, number, number] = [255, 255, 255]): Img {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([...fill, 255], i * 4);
  return { width: w, height: h, data };
}
function paint(im: Img, x0: number, y0: number, w: number, h: number, c: [number, number, number]): Img {
  const out = { ...im, data: new Uint8Array(im.data) };
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) out.data.set([...c, 255], (y * im.width + x) * 4);
  return out;
}
const sig = (over: Partial<PageSignals> = {}): PageSignals => ({ load: { ok: true, status: 200 }, blank: false, errorScreen: null, consoleErrors: [], pageErrors: [], failedRequests: [], ...over });

describe('normalisation', () => {
  it('makes messages comparable across runs and redacts query values', () => {
    expect(normaliseMessage('Error at http://127.0.0.1:53211/_next/static/chunks/app/page-4f9a1b2c3d.js:12:345\nstack…')).toBe('Error at /_next/static/chunks/app/page-#.js');
    expect(normaliseMessage('GET http://localhost:3000/api/x?token=abc&page=2 failed at 1732350000000')).toBe('GET /api/x?token=…&page=… failed at #');
    expect(normaliseMessage("WebSocket connection to 'ws://localhost:51234/_next/hmr?id=abc' failed")).toBe("WebSocket connection to '/_next/hmr?id=…' failed");
    expect(normaliseMessage('x'.repeat(400))).toHaveLength(300);
    expect(normaliseMessage('deadbeefcafe failed')).toBe('deadbeefcafe failed');
    expect(normalisePath(new URL('http://127.0.0.1:1/api/u?secret=1'))).toBe('/api/u?secret=…');
  });

  it('own origin: same port on any local host name', () => {
    const o = new URL('http://127.0.0.1:4000');
    expect(isOwnOrigin('http://localhost:4000/x', o)).toBe(true);
    expect(isOwnOrigin('http://127.0.0.1:4001/x', o)).toBe(false);
    expect(isOwnOrigin('https://cdn.example.com/x', o)).toBe(false);
  });

  it('page slugs are file-safe and distinct', () => {
    expect(pageSlug('/')).toMatch(/^index-\w{6}$/);
    expect(pageSlug('/blog/a b?x=1')).toMatch(/^blog-a-b-x-1-\w{6}$/);
    expect(pageSlug('/a/b')).not.toBe(pageSlug('/a-b'));
  });
});

describe('images', () => {
  it('noisy regions cover what changed, snapped to a 16px grid and grown by two cells', () => {
    const a = img(200, 100);
    const b = paint(a, 50, 40, 10, 5, [0, 0, 0]);
    expect(noisyRegions(a, b)).toEqual([{ x: 16, y: 0, width: 80, height: 80 }]);
    expect(noisyRegions(a, b, 16, 1)).toEqual([{ x: 32, y: 16, width: 48, height: 48 }]);
    expect(noisyRegions(a, a)).toEqual([]);
    // Height change: the extra area is noisy.
    const tall = img(200, 140);
    const r = noisyRegions(a, tall);
    expect(r.some((x) => x.y + x.height >= 140)).toBe(true);
  });

  it('diffs ignore noisy regions and pad different sizes', async () => {
    const a = img(100, 100);
    const b = paint(a, 10, 10, 20, 20, [0, 0, 0]);
    const d = await diffImages(a, b);
    expect(d.changed).toBe(400);
    const ignored = await diffImages(a, b, [{ x: 0, y: 0, width: 40, height: 40 }]);
    expect(ignored.changed).toBe(0);
    // Moved by 1px: not a change; moved by 5px: a change.
    const box = paint(a, 40, 40, 12, 12, [0, 0, 0]);
    expect((await diffImages(box, paint(a, 41, 40, 12, 12, [0, 0, 0]))).changed).toBe(0);
    expect((await diffImages(box, paint(a, 45, 40, 12, 12, [0, 0, 0]))).changed).toBeGreaterThan(50);
    // A different glyph in the same place (L vs T, 1px strokes) is a change.
    const L = paint(paint(a, 60, 60, 1, 8, [0, 0, 0]), 60, 67, 6, 1, [0, 0, 0]);
    const Tg = paint(paint(a, 60, 60, 7, 1, [0, 0, 0]), 63, 60, 1, 8, [0, 0, 0]);
    expect((await diffImages(L, Tg)).changed).toBeGreaterThan(5);
    const taller = await diffImages(a, img(100, 120));
    expect(taller.sizeChanged).toBe(true);
    expect(taller.changed).toBe(2000);
  });

  it('a single-colour screenshot is blank; a sparse page is not', () => {
    expect(isSingleColour(img(300, 300))).toBe(true);
    expect(isSingleColour(paint(img(1280, 800), 20, 20, 120, 14, [30, 30, 30]))).toBe(false);
  });
});

describe('flaky signals', () => {
  it('before: problems in only one of the two loads are flaky', () => {
    const { stable, flaky } = mergeBeforeLoads(
      sig({ pageErrors: ['boom'], consoleErrors: ['always'] }),
      sig({ consoleErrors: ['always'], failedRequests: [{ method: 'GET', path: '/api/x', status: 500 }] }),
    );
    expect(stable.consoleErrors).toEqual(['always']);
    expect(stable.pageErrors).toEqual([]);
    expect(flaky).toEqual({ consoleErrors: [], pageErrors: ['boom'], failedRequests: ['GET /api/x 500'] });
    const blank = mergeBeforeLoads(sig({ blank: true }), sig());
    expect(blank.stable.blank).toBe(false);
    expect(blank.flaky?.blank).toBe(true);
  });

  it('after: a new problem must reproduce on one of up to 2 reloads', async () => {
    let calls = 0;
    const once = await confirmNew(sig({ pageErrors: ['boom'] }), new Set(), async () => (calls++, sig()));
    expect(calls).toBe(2);
    expect(once.rechecks).toBe(2);
    expect(once.stable.pageErrors).toEqual([]);
    expect(once.flaky?.pageErrors).toEqual(['boom']);

    let n = 0;
    const second = await confirmNew(sig({ pageErrors: ['boom'] }), new Set(), async () => (++n === 2 ? sig({ pageErrors: ['boom'] }) : sig()));
    expect(second.rechecks).toBe(2);
    expect(second.stable.pageErrors).toEqual(['boom']);
    expect(second.flaky).toBeUndefined();

    let none = 0;
    const known = await confirmNew(sig({ pageErrors: ['old'] }), new Set(['pageerror:old']), async () => (none++, sig()));
    expect(none).toBe(0);
    expect(known.rechecks).toBe(0);
  });
});

describe('compare', () => {
  const cap = (results: PageResult[]): VisualCapture => ({ version: 1, status: 'ok', results, ms: 1 });
  const res = (page: string, viewport: 'desktop' | 'mobile', over: Partial<PageResult> = {}): PageResult => ({ page, viewport, ...sig(), ms: 1, ...over });
  const opts = () => ({ root: tmpDir(), title: 'Visual', threshold: 0.0002, minPixels: 25, diffDir: tmpDir() });

  it('flaky signals from before are never new', async () => {
    const b = cap([res('/', 'desktop', { flaky: { consoleErrors: ['x'], pageErrors: [], failedRequests: [], load: true } })]);
    const a = cap([res('/', 'desktop', { consoleErrors: ['x'], load: { ok: false, status: 500 } })]);
    const r = await compareVisual(b, a, opts());
    expect(r.findings).toEqual([]);
    expect(r.status).toBe('ok');
  });

  it('merges viewports and names failed requests', async () => {
    const fr = [{ method: 'POST', path: '/api/save', failure: 'ERR_CONNECTION_REFUSED' }];
    const r = await compareVisual(cap([res('/', 'desktop'), res('/', 'mobile')]), cap([res('/', 'desktop', { failedRequests: fr }), res('/', 'mobile', { failedRequests: fr })]), opts());
    expect(r.findings).toEqual([{ kind: 'regression', title: '/ (desktop, mobile): new failed request: POST /api/save → ERR_CONNECTION_REFUSED' }]);
    expect(r.status).toBe('regressed');
  });
});

describe('storage state', () => {
  it('is adapted to the dev server port in memory, and errors never show its contents', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'auth.json');
    writeFileSync(
      f,
      JSON.stringify({
        cookies: [{ name: 's', value: 'v', domain: '127.0.0.1', path: '/' }, { name: 'x', value: 'y', domain: 'example.com', path: '/' }],
        origins: [{ origin: 'http://localhost:3000', localStorage: [{ name: 'token', value: 't' }] }, { origin: 'https://example.com', localStorage: [] }],
      }),
    );
    const r = await loadStorageState(f, 'auth.json', 'http://localhost:5555');
    if (!r.ok) throw new Error(r.message);
    expect(r.state.cookies.map((c) => c.domain)).toEqual(['127.0.0.1', 'localhost', 'example.com']);
    expect(r.state.origins.map((o) => o.origin)).toEqual(['http://localhost:5555', 'https://example.com']);
    writeFileSync(f, '{"cookies": [SECRET-NOT-JSON');
    const bad = await loadStorageState(f, 'auth.json', 'http://localhost:5555');
    expect(bad).toEqual({ ok: false, message: 'the storage-state file auth.json could not be read as JSON' });
  });
});

describe('settings', () => {
  it('parses pages, masks and defaults; server settings fall back to API live mode', () => {
    const s = visualSettings({ enabled: true, pages: ['/', 'about', { path: '/x', mask: ['.ad'] }, '/', 'https://evil.example', 3], mask: ['.ts', ''] }, { command: 'pnpm dev', startupTimeoutSec: 30 });
    expect(s.pages).toEqual([{ path: '/', mask: [] }, { path: '/about', mask: [] }, { path: '/x', mask: ['.ad'] }]);
    expect(s.mask).toEqual(['.ts']);
    expect(s.command).toBe('pnpm dev');
    expect(s.startupTimeoutSec).toBe(30);
    expect(s.viewports).toEqual({ desktop: { width: 1280, height: 800 }, mobile: { width: 390, height: 844 } });
    expect(visualSettings(undefined).enabled).toBe(false);
  });
});
