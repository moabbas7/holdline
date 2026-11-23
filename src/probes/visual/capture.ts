/// <reference lib="dom" />
/**
 * Load pages in headless Chromium and record what each load says about the page: load
 * status, console and uncaught errors, failed requests to the app's own origin, blank or
 * error screens, and full-page screenshots.
 *
 * Screenshots are made stable: animations and transitions off, fixed viewport, timezone,
 * locale and colour scheme, a wait for the network to go quiet and fonts to load, and
 * configured selectors masked. Dev-server error overlays are hidden in screenshots (their
 * presence is recorded separately). Cookies, headers and storage-state contents are never
 * read or recorded; only paths on the app's origin, with query values replaced by `…`.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import { gitMaybe } from '../../core/git.js';
import { decodePng, diffImages, isSingleColour, noisyRegions } from './image.js';
import { failedRequestKey, type FailedRequest, type FlakySignals, type PageConfig, type PageResult, type PageSignals, type Rect, type ViewportName, type VisualSettings } from './types.js';

// --- Normalisation ----------------------------------------------------------------------------

const LOCAL_ORIGIN = /(?:https?|wss?):\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::\d+)?/gi;

/** Replace query values with `…`. */
function redactQueries(s: string): string {
  return s.replace(/([?&][^=&\s#"'`)]+)=[^&\s#"'`)]*/g, '$1=…');
}

/**
 * Make an error message comparable across runs: the dev server's origin and port, line and
 * column numbers, hashes and long numbers are removed; query values are redacted.
 */
export function normaliseMessage(msg: string): string {
  let s = msg.split('\n').find((l) => l.trim()) ?? '';
  s = s.replace(LOCAL_ORIGIN, '');
  s = redactQueries(s);
  s = s.replace(/:\d+:\d+\b/g, '');
  s = s.replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{8,}\b/gi, '#');
  s = s.replace(/\b\d{4,}\b/g, '#');
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > 300 ? `${s.slice(0, 299)}…` : s;
}

/** Path (and redacted query) of a URL on the app's origin, normalised like messages. */
export function normalisePath(url: URL): string {
  const p = (url.pathname + (url.search ? redactQueries(url.search) : '')).replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{12,}\b/gi, '#');
  return p.length > 200 ? `${p.slice(0, 199)}…` : p;
}

/** Chrome logs a console error for every failed resource; those are covered by failed requests. */
const RESOURCE_ERROR = /^Failed to load resource:/;

// --- Page scripts ------------------------------------------------------------------------------

const STABLE_CSS = `*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}`;
const HIDE_OVERLAYS_CSS = `nextjs-portal,vite-error-overlay,#webpack-dev-server-client-overlay,#__next-build-watcher,[data-nextjs-toast]{display:none!important}`;

const INIT_SCRIPT = `(() => {
  const add = () => {
    if (document.getElementById('__holdline_stable')) return;
    const s = document.createElement('style');
    s.id = '__holdline_stable';
    s.textContent = ${JSON.stringify(STABLE_CSS)};
    (document.head || document.documentElement).appendChild(s);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add, { once: true });
  else add();
})();`;

/** Runs in the page: which error screen is shown, and whether the page shows anything. */
function inspectPage(): { errorScreen: string | null; hasContent: boolean; height: number } {
  let errorScreen: string | null = null;
  // Next.js keeps its overlay in the DOM, hidden, and also uses it for non-error notices:
  // only a visible dialog that shows an error counts.
  const ERROR_TEXT = /Unhandled Runtime Error|Runtime (?:\w*Error|Error)|Build Error|Failed to compile|Console \w*Error|Recoverable Error|Server Error|Unhandled Error/;
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden';
  };
  for (const portal of Array.from(document.querySelectorAll('nextjs-portal'))) {
    const root = portal.shadowRoot;
    if (!root) continue;
    for (const dialog of Array.from(root.querySelectorAll('[data-nextjs-dialog], [data-nextjs-error-overlay], [data-nextjs-dialog-overlay]'))) {
      if (dialog.getAttribute('data-rendered') === 'false' || !visible(dialog)) continue;
      if (ERROR_TEXT.test(dialog.textContent ?? '')) {
        errorScreen = 'Next.js error overlay';
        break;
      }
    }
    if (errorScreen) break;
  }
  if (!errorScreen && document.querySelector('vite-error-overlay')) errorScreen = 'Vite error overlay';
  if (!errorScreen && document.querySelector('#webpack-dev-server-client-overlay')) errorScreen = 'webpack error overlay';
  const body = document.body;
  const text = body ? body.innerText.trim() : '';
  if (!errorScreen && /Application error: a (?:client|server)-side exception has occurred/.test(text)) errorScreen = 'Next.js application error';
  if (!errorScreen && document.getElementById('__next_error__') && /error/i.test(text)) errorScreen = 'Next.js error page';
  let hasContent = text.length > 0;
  if (!hasContent && body) {
    for (const el of Array.from(body.querySelectorAll('img, svg, canvas, video, iframe, input, button, textarea, select, picture, object, embed'))) {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      if (r.width > 1 && r.height > 1 && st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0) {
        hasContent = true;
        break;
      }
    }
  }
  const height = Math.max(document.documentElement.scrollHeight, body ? body.scrollHeight : 0);
  return { errorScreen, hasContent, height };
}

// --- One page load -------------------------------------------------------------------------------

export interface LoadOptions {
  browser: Browser;
  origin: string;
  page: PageConfig;
  viewportName: ViewportName;
  settings: VisualSettings;
  /** Storage state (in memory only; see loadStorageState). */
  storageState?: StorageState;
  /** 0: signals only; 1: one full-page screenshot; 2: two, `noiseDelayMs` apart. */
  screenshots: 0 | 1 | 2;
}

export interface LoadResult {
  signals: PageSignals;
  shots: Buffer[];
  /** Page-coordinate boxes of the masked elements at the first screenshot. */
  masked: Rect[];
  ms: number;
}

export function isOwnOrigin(url: string, origin: URL): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== origin.protocol || u.port !== origin.port) return false;
  return ['localhost', '127.0.0.1', '[::1]', '0.0.0.0', origin.hostname].includes(u.hostname);
}

export async function loadPage(o: LoadOptions): Promise<LoadResult> {
  const t0 = Date.now();
  const vp = o.settings.viewports[o.viewportName];
  const originUrl = new URL(o.origin);
  const signals: PageSignals = { load: { ok: true }, blank: false, errorScreen: null, consoleErrors: [], pageErrors: [], failedRequests: [] };
  const consoleSet = new Set<string>();
  const pageErrSet = new Set<string>();
  const failedSet = new Map<string, FailedRequest>();
  const shots: Buffer[] = [];
  let masked: Rect[] = [];
  let context: BrowserContext | null = null;
  try {
    context = await o.browser.newContext({
      viewport: vp,
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
      timezoneId: 'UTC',
      locale: 'en-US',
      colorScheme: 'light',
      reducedMotion: 'reduce',
      serviceWorkers: 'block',
      ...(o.storageState ? { storageState: o.storageState as never } : {}),
    });
    await context.addInitScript(INIT_SCRIPT);
    const page = await context.newPage();
    const navTimeout = o.settings.pageTimeoutSec * 1000;
    page.setDefaultTimeout(navTimeout);
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const text = m.text();
      if (RESOURCE_ERROR.test(text)) return;
      const n = normaliseMessage(text);
      if (n) consoleSet.add(n);
    });
    page.on('pageerror', (e) => {
      const n = normaliseMessage(`${e.name && e.name !== 'Error' ? `${e.name}: ` : ''}${e.message || String(e)}`);
      if (n) pageErrSet.add(n);
    });
    const isMainNav = (req: { isNavigationRequest(): boolean; frame(): { parentFrame(): unknown } }) => {
      try {
        return req.isNavigationRequest() && req.frame().parentFrame() === null;
      } catch {
        return false;
      }
    };
    page.on('response', (r) => {
      if (r.status() < 400 || !isOwnOrigin(r.url(), originUrl) || isMainNav(r.request())) return;
      const f: FailedRequest = { method: r.request().method(), path: normalisePath(new URL(r.url())), status: r.status() };
      failedSet.set(failedRequestKey(f), f);
    });
    page.on('requestfailed', (req) => {
      const failure = req.failure()?.errorText ?? 'failed';
      if (/ERR_ABORTED|NS_BINDING_ABORTED|cancelled/i.test(failure)) return;
      if (!isOwnOrigin(req.url(), originUrl) || isMainNav(req)) return;
      const f: FailedRequest = { method: req.method(), path: normalisePath(new URL(req.url())), failure: failure.replace(/^net::/, '') };
      failedSet.set(failedRequestKey(f), f);
    });

    const url = new URL(o.page.path, o.origin).toString();
    let loaded = false;
    try {
      const resp = await page.goto(url, { waitUntil: 'load', timeout: navTimeout });
      const status = resp?.status();
      signals.load = status !== undefined && status >= 400 ? { ok: false, status } : { ok: true, ...(status !== undefined ? { status } : {}) };
      loaded = true;
    } catch (e) {
      const msg = (e as Error).message ?? '';
      signals.load = { ok: false, error: /timeout/i.test(msg) ? `did not load within ${o.settings.pageTimeoutSec}s` : normaliseMessage(msg.replace(/^page\.goto:\s*/, '')) };
    }

    if (loaded) {
      await page.waitForLoadState('networkidle', { timeout: Math.min(o.settings.networkIdleTimeoutSec * 1000, navTimeout) }).catch(() => {});
      await page.evaluate(() => document.fonts?.ready.then(() => undefined)).catch(() => {});
      await settle(page);
      const info = await page.evaluate(inspectPage).catch(() => ({ errorScreen: null, hasContent: true, height: vp.height }));
      signals.errorScreen = info.errorScreen;
      await page.addStyleTag({ content: HIDE_OVERLAYS_CSS }).catch(() => {});
      const viewportShot = await page.screenshot({ animations: 'disabled', caret: 'hide', scale: 'css' }).catch(() => null);
      const viewportBlank = viewportShot ? isSingleColour(await decodePng(viewportShot)) : false;
      signals.blank = !info.errorScreen && (!info.hasContent || viewportBlank);
      const masks = [...o.settings.mask, ...o.page.mask];
      if (o.screenshots > 0 && masks.length) masked = await maskBoxes(page, masks);
      for (let i = 0; i < o.screenshots; i++) {
        if (i > 0) {
          await page.waitForTimeout(o.settings.noiseDelayMs);
          await settle(page);
        }
        shots.push(await fullShot(page, vp.width, o.settings.maxHeight, masks));
      }
    }
  } catch (e) {
    // Browser or context errors: the page could not be checked.
    if (signals.load.ok) signals.load = { ok: false, error: normaliseMessage((e as Error).message ?? String(e)) };
  } finally {
    await context?.close().catch(() => {});
  }
  signals.consoleErrors = [...consoleSet];
  signals.pageErrors = [...pageErrSet];
  signals.failedRequests = [...failedSet.values()];
  return { signals, shots, masked, ms: Date.now() - t0 };
}

/** Page-coordinate boxes of every element matching the mask selectors (rounded outwards). */
async function maskBoxes(page: Page, selectors: string[]): Promise<Rect[]> {
  const out: Rect[] = [];
  for (const sel of selectors) {
    const boxes = await page
      .locator(sel)
      .evaluateAll((els) =>
        els.map((e) => {
          const r = e.getBoundingClientRect();
          return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height };
        }),
      )
      .catch(() => [] as Rect[]);
    for (const b of boxes) {
      if (b.width <= 0 || b.height <= 0) continue;
      const x = Math.max(0, Math.floor(b.x) - 1);
      const y = Math.max(0, Math.floor(b.y) - 1);
      out.push({ x, y, width: Math.ceil(b.x + b.width) + 1 - x, height: Math.ceil(b.y + b.height) + 1 - y });
    }
  }
  return out;
}

async function settle(page: Page): Promise<void> {
  await page
    .evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
    .catch(() => {});
  await page.waitForTimeout(150);
}

async function fullShot(page: Page, width: number, maxHeight: number, masks: string[]): Promise<Buffer> {
  const height = await page
    .evaluate(() => Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0))
    .catch(() => 0);
  const h = Math.max(1, Math.min(maxHeight, height || 1));
  return page.screenshot({
    fullPage: true,
    clip: { x: 0, y: 0, width, height: h },
    animations: 'disabled',
    caret: 'hide',
    scale: 'css',
    mask: masks.map((m) => page.locator(m)),
    maskColor: '#FF00FF',
  });
}

// --- Signals: keys, flaky, rechecks -------------------------------------------------------------

/** Every problem a load showed, as comparable keys. */
export function signalKeys(s: PageSignals): Set<string> {
  const keys = new Set<string>();
  if (!s.load.ok) keys.add('load');
  if (s.blank) keys.add('blank');
  if (s.errorScreen) keys.add(`errorScreen:${s.errorScreen}`);
  for (const m of s.consoleErrors) keys.add(`console:${m}`);
  for (const m of s.pageErrors) keys.add(`pageerror:${m}`);
  for (const f of s.failedRequests) keys.add(`request:${failedRequestKey(f)}`);
  return keys;
}

/** Keys a "before" result accepts as known: everything seen, including flaky signals. */
export function knownKeys(r: PageResult): Set<string> {
  const keys = signalKeys(r);
  const f = r.flaky;
  if (f) {
    if (f.load) keys.add('load');
    if (f.blank) keys.add('blank');
    if (f.errorScreen) keys.add(`errorScreen:${f.errorScreen}`);
    for (const m of f.consoleErrors) keys.add(`console:${m}`);
    for (const m of f.pageErrors) keys.add(`pageerror:${m}`);
    for (const k of f.failedRequests) keys.add(`request:${k}`);
  }
  return keys;
}

const emptyFlaky = (): FlakySignals => ({ consoleErrors: [], pageErrors: [], failedRequests: [] });

/** Split `signals` so the keys in `flakyKeys` move into a FlakySignals record. */
function splitFlaky(signals: PageSignals, flakyKeys: Set<string>, alt?: PageSignals): { stable: PageSignals; flaky: FlakySignals | undefined } {
  if (flakyKeys.size === 0) return { stable: signals, flaky: undefined };
  const flaky = emptyFlaky();
  const stable: PageSignals = { ...signals, consoleErrors: [], pageErrors: [], failedRequests: [] };
  if (flakyKeys.has('load')) {
    flaky.load = true;
    if (!signals.load.ok && alt?.load.ok) stable.load = alt.load;
  }
  if (flakyKeys.has('blank')) {
    flaky.blank = true;
    stable.blank = false;
  }
  const es = [...flakyKeys].find((k) => k.startsWith('errorScreen:'));
  if (es) {
    flaky.errorScreen = es.slice('errorScreen:'.length);
    if (signals.errorScreen === flaky.errorScreen) stable.errorScreen = null;
  }
  for (const m of signals.consoleErrors) (flakyKeys.has(`console:${m}`) ? flaky.consoleErrors : stable.consoleErrors).push(m);
  for (const m of signals.pageErrors) (flakyKeys.has(`pageerror:${m}`) ? flaky.pageErrors : stable.pageErrors).push(m);
  for (const f of signals.failedRequests) {
    const k = failedRequestKey(f);
    if (flakyKeys.has(`request:${k}`)) flaky.failedRequests.push(k);
    else stable.failedRequests.push(f);
  }
  // Flaky signals only in the other load.
  if (alt) {
    for (const m of alt.consoleErrors) if (flakyKeys.has(`console:${m}`) && !flaky.consoleErrors.includes(m)) flaky.consoleErrors.push(m);
    for (const m of alt.pageErrors) if (flakyKeys.has(`pageerror:${m}`) && !flaky.pageErrors.includes(m)) flaky.pageErrors.push(m);
    for (const f of alt.failedRequests) {
      const k = failedRequestKey(f);
      if (flakyKeys.has(`request:${k}`) && !flaky.failedRequests.includes(k)) flaky.failedRequests.push(k);
    }
    if (alt.errorScreen && flakyKeys.has(`errorScreen:${alt.errorScreen}`)) flaky.errorScreen = alt.errorScreen;
  }
  return { stable, flaky };
}

/** Combine the two "before" loads: signals seen in only one are flaky. */
export function mergeBeforeLoads(a: PageSignals, b: PageSignals): { stable: PageSignals; flaky: FlakySignals | undefined } {
  const ka = signalKeys(a);
  const kb = signalKeys(b);
  const flakyKeys = new Set([...ka, ...kb].filter((k) => ka.has(k) !== kb.has(k)));
  return splitFlaky(a, flakyKeys, b);
}

/**
 * New problems in an "after" load must reproduce on at least one of up to `retries` fresh
 * loads; the ones that never do are flaky. `reload` performs one fresh load.
 */
export async function confirmNew(
  signals: PageSignals,
  known: Set<string>,
  reload: () => Promise<PageSignals>,
  retries = 2,
  /** Something else also wants reloads (a visual difference not confirmed yet). */
  morePending: () => boolean = () => false,
): Promise<{ stable: PageSignals; flaky: FlakySignals | undefined; rechecks: number }> {
  const fresh = [...signalKeys(signals)].filter((k) => !known.has(k));
  if (fresh.length === 0 && !morePending()) return { stable: signals, flaky: undefined, rechecks: 0 };
  const pending = new Set(fresh);
  let rechecks = 0;
  for (let i = 0; i < retries && (pending.size > 0 || morePending()); i++) {
    rechecks++;
    const again = signalKeys(await reload());
    for (const k of [...pending]) if (again.has(k)) pending.delete(k);
  }
  const { stable, flaky } = splitFlaky(signals, pending);
  return { stable, flaky, rechecks };
}

// --- Storage state --------------------------------------------------------------------------------

export type StorageStateCheck = { ok: true; path?: string } | { ok: false; message: string };

/**
 * Resolve the configured storage-state path. It is used in place (never copied, read or
 * printed beyond its path). A file inside the repo that git does not ignore is refused:
 * holdline snapshots untracked files, so its cookies would end up in refs/holdline/.
 */
export async function checkStorageState(root: string, configured: string | undefined): Promise<StorageStateCheck> {
  if (!configured) return { ok: true };
  const expanded = configured.startsWith('~/') ? path.join(os.homedir(), configured.slice(2)) : configured;
  const abs = path.resolve(root, expanded);
  if (!existsSync(abs)) return { ok: false, message: `the storage-state file ${configured} (probes.visual.storageState) does not exist. Create it with Playwright (for example \`npx playwright codegen --save-storage=<file> <url>\`).` };
  const rel = path.relative(root, abs);
  const inside = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  if (inside) {
    const ignored = await gitMaybe(['check-ignore', '-q', '--', rel], { cwd: root });
    if (ignored === null) {
      return {
        ok: false,
        message: `the storage-state file ${rel} is inside the project and not git-ignored, so holdline snapshots would include its cookies and tokens. Add it to .gitignore or move it outside the project.`,
      };
    }
  }
  return { ok: true, path: abs };
}

type StorageState = { cookies: Record<string, unknown>[]; origins: { origin: string; localStorage: unknown[] }[] };
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0']);

/**
 * Read the storage-state file into memory for this run only, adapted to the dev server's
 * random port: localStorage entries for local origins move to `origin`, and cookies for
 * 127.0.0.1/::1 also apply to localhost. Nothing from it is written or printed; errors
 * mention only the path.
 */
export async function loadStorageState(file: string, shown: string, origin: string): Promise<{ ok: true; state: StorageState } | { ok: false; message: string }> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return { ok: false, message: `the storage-state file ${shown} could not be read as JSON` };
  }
  if (!raw || typeof raw !== 'object') return { ok: false, message: `the storage-state file ${shown} is not a Playwright storage state` };
  const r = raw as { cookies?: unknown; origins?: unknown };
  const cookies: Record<string, unknown>[] = [];
  for (const c of Array.isArray(r.cookies) ? r.cookies : []) {
    if (!c || typeof c !== 'object') continue;
    const cookie = c as Record<string, unknown>;
    cookies.push(cookie);
    const domain = typeof cookie.domain === 'string' ? cookie.domain.replace(/^\./, '') : '';
    if (LOCAL_HOSTS.has(domain) && domain !== 'localhost') cookies.push({ ...cookie, domain: 'localhost' });
  }
  const origins: StorageState['origins'] = [];
  for (const o of Array.isArray(r.origins) ? r.origins : []) {
    if (!o || typeof o !== 'object' || typeof (o as { origin?: unknown }).origin !== 'string') continue;
    const entry = o as { origin: string; localStorage?: unknown };
    let local = false;
    try {
      local = LOCAL_HOSTS.has(new URL(entry.origin).hostname);
    } catch {
      /* keep as is */
    }
    origins.push({ origin: local ? origin : entry.origin, localStorage: Array.isArray(entry.localStorage) ? entry.localStorage : [] });
  }
  return { ok: true, state: { cookies, origins } };
}

// --- Run all pages ------------------------------------------------------------------------------

export type CaptureMode = 'before' | 'after' | 'current';

export interface CapturePagesOptions {
  root: string;
  browser: Browser;
  origin: string;
  settings: VisualSettings;
  mode: CaptureMode;
  /** Absolute directory for this capture's screenshots (cleared first). */
  outDir: string;
  storageState?: StorageState;
  /** after: the "before" results, to confirm new problems by reloading. */
  before?: PageResult[];
  progress?: (msg: string) => void;
}

const healthy = (r: PageSignals) => r.load.ok && !r.blank && !r.errorScreen;

/** Changed share of pixels between a "before" result and an after screenshot (as compare does it). */
async function visualDelta(root: string, prev: PageResult, shot: Buffer, masked: Rect[], settings: VisualSettings): Promise<boolean> {
  if (!prev.screenshot) return false;
  let before: Buffer;
  try {
    before = await readFile(path.join(root, prev.screenshot.file));
  } catch {
    return false;
  }
  const d = await diffImages(await decodePng(before), await decodePng(shot), [...(prev.noisy ?? []), ...(prev.masked ?? []), ...masked]);
  return d.ratio > settings.threshold && d.changed >= settings.minPixels;
}

/**
 * A visual difference must show on every load: when the after screenshot differs from
 * before, the reloads made to confirm problems also take a screenshot. If one looks like
 * before, the difference was content that varies per load (random tips, rotating banners),
 * and that matching screenshot is kept.
 */
async function visualConfirmer(
  o: CapturePagesOptions,
  prev: PageResult,
  result: PageResult,
  masked: Rect[],
): Promise<{ pending: () => boolean; check: (again: LoadResult) => Promise<void> }> {
  let pending = false;
  if (result.screenshot && healthy(prev) && healthy(result)) {
    pending = await visualDelta(o.root, prev, await readFile(path.join(o.root, result.screenshot.file)), masked, o.settings);
  }
  return {
    pending: () => pending,
    async check(again) {
      if (!pending || !result.screenshot) return;
      const shot = again.shots[0];
      if (!shot || !healthy(again.signals)) return;
      if (await visualDelta(o.root, prev, shot, again.masked, o.settings)) return;
      pending = false;
      await writeFile(path.join(o.root, result.screenshot.file), shot);
      const img = await decodePng(shot);
      result.screenshot = { file: result.screenshot.file, width: img.width, height: img.height, sha256: createHash('sha256').update(shot).digest('hex') };
      if (again.masked.length) result.masked = again.masked;
      else delete result.masked;
      result.variesPerLoad = true;
    },
  };
}

export function pageSlug(p: string): string {
  const base = p === '/' ? 'index' : p.replace(/^\/+/, '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'page';
  const hash = createHash('sha256').update(p).digest('hex').slice(0, 6);
  return `${base}-${hash}`;
}

const VIEWPORTS: ViewportName[] = ['desktop', 'mobile'];

export async function capturePages(o: CapturePagesOptions): Promise<PageResult[]> {
  await rm(o.outDir, { recursive: true, force: true });
  await mkdir(o.outDir, { recursive: true });
  const results: PageResult[] = [];
  const beforeIndex = new Map((o.before ?? []).map((r) => [`${r.page}\0${r.viewport}`, r]));
  for (const page of o.settings.pages) {
    o.progress?.(`  visual: ${page.path} …`);
    // Desktop and mobile load in parallel (separate contexts).
    const perViewport = await Promise.all(
      VIEWPORTS.map(async (vpName): Promise<PageResult> => {
        const base = { browser: o.browser, origin: o.origin, page, viewportName: vpName, settings: o.settings, ...(o.storageState ? { storageState: o.storageState } : {}) };
        const first = await loadPage({ ...base, screenshots: o.mode === 'after' ? 1 : 2 });
        const result: PageResult = { page: page.path, viewport: vpName, ...first.signals, ms: first.ms };
        if (first.shots[0]) {
          const file = path.join(o.outDir, `${pageSlug(page.path)}--${vpName}.png`);
          await writeFile(file, first.shots[0]);
          const img = await decodePng(first.shots[0]);
          result.screenshot = {
            file: path.relative(o.root, file).split(path.sep).join('/'),
            width: img.width,
            height: img.height,
            sha256: createHash('sha256').update(first.shots[0]).digest('hex'),
          };
          if (first.masked.length) result.masked = first.masked;
          if (first.shots[1]) {
            const noisy: Rect[] = noisyRegions(img, await decodePng(first.shots[1]));
            if (noisy.length) result.noisy = noisy;
          }
        }
        if (o.mode === 'before') {
          // A second, independent load: problems seen in only one load are flaky, and regions
          // that differ between the loads (random content per load) are noisy too.
          const second = await loadPage({ ...base, screenshots: 1 });
          if (first.shots[0] && second.shots[0]) {
            const between = noisyRegions(await decodePng(first.shots[0]), await decodePng(second.shots[0]));
            if (between.length) result.noisy = [...(result.noisy ?? []), ...between];
          }
          const { stable, flaky } = mergeBeforeLoads(first.signals, second.signals);
          Object.assign(result, stable);
          if (flaky) result.flaky = flaky;
          result.ms += second.ms;
        } else if (o.mode === 'after') {
          const prev = beforeIndex.get(`${page.path}\0${vpName}`);
          if (prev) {
            // One set of reloads (up to 2) confirms both new problems and a visual difference.
            const visual = await visualConfirmer(o, prev, result, first.masked);
            const { stable, flaky, rechecks } = await confirmNew(
              first.signals,
              knownKeys(prev),
              async () => {
                const again = await loadPage({ ...base, screenshots: visual.pending() ? 1 : 0 });
                result.ms += again.ms;
                await visual.check(again);
                return again.signals;
              },
              2,
              visual.pending,
            );
            Object.assign(result, stable);
            if (flaky) result.flaky = flaky;
            if (rechecks) result.rechecks = rechecks;
          }
        }
        return result;
      }),
    );
    results.push(...perViewport);
  }
  return results;
}
