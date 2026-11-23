/** Bumped when the capture format changes. */
export const VISUAL_CAPTURE_VERSION = 1;

export type ViewportName = 'desktop' | 'mobile';

export interface Viewport {
  width: number;
  height: number;
}

export interface PageConfig {
  path: string;
  /** Extra CSS selectors to mask on this page. */
  mask: string[];
}

export interface VisualSettings {
  enabled: boolean;
  pages: PageConfig[];
  /** CSS selectors masked on every page (timestamps, ads, avatars). */
  mask: string[];
  viewports: Record<ViewportName, Viewport>;
  /** Path to a Playwright storage-state file the user created. Used in place, never copied. */
  storageState?: string;
  /** Dev server command (default: probes.api.live.command, then `<pm> run dev`). */
  command?: string;
  startupTimeoutSec: number;
  pageTimeoutSec: number;
  /** How long to wait for the network to go quiet after load (pages that keep polling never do). */
  networkIdleTimeoutSec: number;
  /** A visual difference is reported when more than this fraction of pixels changed… */
  threshold: number;
  /** …and at least this many pixels. */
  minPixels: number;
  /** Delay between the two "before" screenshots used to find noisy (live) regions. */
  noiseDelayMs: number;
  /** Full-page screenshots are clipped to this height. */
  maxHeight: number;
  allowNonLocalDatabase: boolean;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FailedRequest {
  method: string;
  /** Path on the app's own origin, query values replaced by `…`. */
  path: string;
  status?: number;
  failure?: string;
}

/** Everything a single page load says about the page's health (no pixels). */
export interface PageSignals {
  load: { ok: boolean; status?: number; error?: string };
  blank: boolean;
  /** Name of the error screen shown (e.g. "Next.js error overlay"), or null. */
  errorScreen: string | null;
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: FailedRequest[];
}

export interface Screenshot {
  /** Relative to the project root. */
  file: string;
  width: number;
  height: number;
  sha256: string;
}

/** Signals seen in only one of the loads (before), or that did not reproduce (after). */
export interface FlakySignals {
  load?: boolean;
  blank?: boolean;
  errorScreen?: string;
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: string[];
}

export interface PageResult extends PageSignals {
  page: string;
  viewport: ViewportName;
  screenshot?: Screenshot;
  /** Regions that changed between two "before" screenshots (live content); ignored when comparing. */
  noisy?: Rect[];
  /** Boxes of masked elements in the screenshot; ignored when comparing (with the other run's). */
  masked?: Rect[];
  /** Signals not seen on every load in `before`: never counted as new in `after`. */
  flaky?: FlakySignals;
  /** Extra loads made to confirm new problems or a visual difference (after). */
  rechecks?: number;
  /** The first after screenshot differed but a reload matched before (content varies per load). */
  variesPerLoad?: boolean;
  ms: number;
}

export interface VisualCapture {
  version: number;
  status: 'ok' | 'off' | 'unavailable' | 'refused' | 'failed';
  message?: string;
  results: PageResult[];
  ms: number;
}

export interface VisualRef {
  file: string;
  sha256: string;
  status: VisualCapture['status'];
  pages: number;
}

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d);
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : []);

export const DEFAULT_VIEWPORTS: Record<ViewportName, Viewport> = {
  desktop: { width: 1280, height: 800 },
  mobile: { width: 390, height: 844 },
};

function viewport(v: unknown, d: Viewport): Viewport {
  if (!v || typeof v !== 'object') return d;
  const o = v as Record<string, unknown>;
  const w = num(o.width, d.width);
  const h = num(o.height, d.height);
  return { width: Math.max(100, Math.round(w)), height: Math.max(100, Math.round(h)) };
}

export function normalisePagePath(p: string): string | null {
  const t = p.trim();
  if (!t) return null;
  if (t.includes('://') || t.startsWith('//')) return null;
  return t.startsWith('/') ? t : `/${t}`;
}

/** Parse probes.visual from the config; api live settings provide server defaults. */
export function visualSettings(raw: Record<string, unknown> | undefined, apiLive?: Record<string, unknown>): VisualSettings {
  const r = raw ?? {};
  const pages: PageConfig[] = [];
  const seen = new Set<string>();
  for (const p of Array.isArray(r.pages) ? r.pages : []) {
    const pathStr = typeof p === 'string' ? p : p && typeof p === 'object' && typeof (p as { path?: unknown }).path === 'string' ? (p as { path: string }).path : null;
    const norm = pathStr ? normalisePagePath(pathStr) : null;
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    pages.push({ path: norm, mask: typeof p === 'object' ? strs((p as { mask?: unknown }).mask) : [] });
  }
  const vp = (r.viewports && typeof r.viewports === 'object' ? r.viewports : {}) as Record<string, unknown>;
  const command = typeof r.command === 'string' ? r.command : typeof apiLive?.command === 'string' ? apiLive.command : undefined;
  return {
    enabled: r.enabled === true,
    pages,
    mask: strs(r.mask),
    viewports: { desktop: viewport(vp.desktop, DEFAULT_VIEWPORTS.desktop), mobile: viewport(vp.mobile, DEFAULT_VIEWPORTS.mobile) },
    ...(typeof r.storageState === 'string' && r.storageState.trim() ? { storageState: r.storageState.trim() } : {}),
    ...(command ? { command } : {}),
    startupTimeoutSec: num(r.startupTimeoutSec, num(apiLive?.startupTimeoutSec, 90)),
    pageTimeoutSec: num(r.pageTimeoutSec, 60),
    networkIdleTimeoutSec: num(r.networkIdleTimeoutSec, 5),
    threshold: num(r.threshold, 0.0002),
    minPixels: num(r.minPixels, 25),
    noiseDelayMs: num(r.noiseDelayMs, 1000),
    maxHeight: Math.max(200, num(r.maxHeight, 4000)),
    allowNonLocalDatabase: r.allowNonLocalDatabase === true,
  };
}

export const failedRequestKey = (f: FailedRequest) => `${f.method} ${f.path} ${f.status ?? f.failure ?? ''}`.trim();
