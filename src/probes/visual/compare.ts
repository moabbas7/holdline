/**
 * Compare two visual captures. Regressions: a page that loaded cleanly now fails to load,
 * is blank or shows an error screen; new console or uncaught errors; new failed requests to
 * the app's own origin (each confirmed by a reload in `after`). Visual differences are
 * changes only, as are problems that appeared once and did not reproduce ("flaky").
 */
import { readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Finding, ProbeReport } from '../types.js';
import { knownKeys, pageSlug, signalKeys } from './capture.js';
import { decodePng, diffImages, encodePng } from './image.js';
import { type FlakySignals, type PageResult, type VisualCapture } from './types.js';
import { plural } from '../../plural.js';

export interface CompareOptions {
  root: string;
  title: string;
  threshold: number;
  minPixels: number;
  /** Absolute directory for diff images (cleared first). */
  diffDir: string;
}

interface Raw {
  kind: Finding['kind'];
  page: string;
  viewport: string;
  text: string;
  lines?: string[];
  images?: { before: string; after: string; diff: string };
}

function describeKey(key: string, r: PageResult): string {
  if (key === 'load') return r.load.status ? `returns HTTP ${r.load.status}` : `does not load (${r.load.error ?? 'error'})`;
  if (key === 'blank') return 'is blank';
  if (key.startsWith('errorScreen:')) return `shows the ${key.slice('errorScreen:'.length)}`;
  if (key.startsWith('console:')) return `console error: ${key.slice('console:'.length)}`;
  if (key.startsWith('pageerror:')) return `uncaught error: ${key.slice('pageerror:'.length)}`;
  if (key.startsWith('request:')) return `failed request: ${key.slice('request:'.length)}`;
  return key;
}

function regressionText(key: string, r: PageResult): string {
  if (key === 'load') return `no longer loads: ${r.load.status ? `HTTP ${r.load.status}` : (r.load.error ?? 'error')}`;
  if (key === 'blank') return 'is now blank';
  if (key.startsWith('errorScreen:')) return `now shows the ${key.slice('errorScreen:'.length)}`;
  if (key.startsWith('console:')) return `new console error: ${key.slice('console:'.length)}`;
  if (key.startsWith('pageerror:')) return `new uncaught error: ${key.slice('pageerror:'.length)}`;
  if (key.startsWith('request:')) {
    const k = key.slice('request:'.length);
    const m = /^(\S+) (\S+)(?: (.+))?$/.exec(k);
    return m ? `new failed request: ${m[1]} ${m[2]}${m[3] ? ` → ${m[3]}` : ''}` : `new failed request: ${k}`;
  }
  return key;
}

function flakyLines(f: FlakySignals): string[] {
  const out: string[] = [];
  if (f.load) out.push('failed to load');
  if (f.blank) out.push('was blank');
  if (f.errorScreen) out.push(`showed the ${f.errorScreen}`);
  for (const m of f.consoleErrors) out.push(`console error: ${m}`);
  for (const m of f.pageErrors) out.push(`uncaught error: ${m}`);
  for (const k of f.failedRequests) out.push(`failed request: ${k}`);
  return out;
}

const STATE_KEYS = (k: string) => k === 'load' || k === 'blank' || k.startsWith('errorScreen:');

export async function compareVisual(before: VisualCapture, after: VisualCapture, o: CompareOptions): Promise<ProbeReport> {
  const raws: Raw[] = [];
  const bIndex = new Map(before.results.map((r) => [`${r.page}\0${r.viewport}`, r]));
  await rm(o.diffDir, { recursive: true, force: true });
  let visualChanges = 0;

  for (const a of after.results) {
    const b = bIndex.get(`${a.page}\0${a.viewport}`);
    if (!b) {
      raws.push({ kind: 'info', page: a.page, viewport: a.viewport, text: 'not checked by `holdline before` (added to the config since?)' });
      continue;
    }
    const known = knownKeys(b);
    const aKeys = signalKeys(a);
    const bStable = signalKeys(b);

    for (const k of aKeys) {
      if (known.has(k)) continue;
      raws.push({ kind: 'regression', page: a.page, viewport: a.viewport, text: regressionText(k, a) });
    }
    if (a.flaky) {
      const lines = flakyLines(a.flaky);
      if (lines.length) {
        raws.push({
          kind: 'change',
          page: a.page,
          viewport: a.viewport,
          text: `flaky: appeared once but not on ${plural(a.rechecks ?? 2, 'reload')}`,
          lines,
        });
      }
    }
    // Problems from before that are gone, or still there.
    const aAll = knownKeys(a);
    for (const k of bStable) {
      if (!STATE_KEYS(k)) {
        if (!aAll.has(k)) raws.push({ kind: 'fixed', page: a.page, viewport: a.viewport, text: `no longer: ${describeKey(k, b)}` });
        continue;
      }
      if (aKeys.has(k)) raws.push({ kind: 'still-failing', page: a.page, viewport: a.viewport, text: `still ${describeKey(k, a)}` });
      else if (!aAll.has(k)) raws.push({ kind: 'fixed', page: a.page, viewport: a.viewport, text: `no longer ${describeKey(k, b)}` });
    }

    if (a.variesPerLoad) {
      raws.push({ kind: 'info', page: a.page, viewport: a.viewport, text: 'looked different on one load but a reload matched (content that varies per load); not reported' });
    }
    // Visual difference (only for pages that rendered in both runs).
    const healthy = (r: PageResult) => r.load.ok && !r.blank && !r.errorScreen;
    if (a.screenshot && b.screenshot && healthy(a) && healthy(b)) {
      let bBuf: Buffer;
      let aBuf: Buffer;
      try {
        bBuf = await readFile(path.join(o.root, b.screenshot.file));
        aBuf = await readFile(path.join(o.root, a.screenshot.file));
      } catch {
        raws.push({ kind: 'info', page: a.page, viewport: a.viewport, text: 'screenshot missing; visual comparison skipped' });
        continue;
      }
      const d = await diffImages(await decodePng(bBuf), await decodePng(aBuf), [...(b.noisy ?? []), ...(b.masked ?? []), ...(a.masked ?? [])]);
      const total = d.diff.width * d.diff.height;
      if (total > 0 && d.compared / total < 0.5) {
        raws.push({
          kind: 'info',
          page: a.page,
          viewport: a.viewport,
          text: `${Math.round((1 - d.compared / total) * 100)}% of the page changes on every load or is masked, so only the rest was compared`,
        });
      }
      if (d.ratio > o.threshold && d.changed >= o.minPixels) {
        visualChanges++;
        await mkdir(o.diffDir, { recursive: true });
        const diffFile = path.join(o.diffDir, `${pageSlug(a.page)}--${a.viewport}.png`);
        await writeFile(diffFile, await encodePng(d.diff));
        const rel = (p: string) => path.relative(o.root, p).split(path.sep).join('/');
        const pct = d.ratio * 100;
        const size = d.sizeChanged ? `, size ${b.screenshot.width}×${b.screenshot.height} → ${a.screenshot.width}×${a.screenshot.height}` : '';
        raws.push({
          kind: 'change',
          page: a.page,
          viewport: a.viewport,
          text: `looks different (${pct < 0.1 ? pct.toFixed(2) : pct.toFixed(1)}% of pixels changed${size})`,
          lines: [`before: ${b.screenshot.file}`, `after:  ${a.screenshot.file}`, `diff:   ${rel(diffFile)}`],
          images: { before: b.screenshot.file, after: a.screenshot.file, diff: rel(diffFile) },
        });
      }
    }
  }

  // Merge identical findings across viewports.
  const order: Finding['kind'][] = ['regression', 'change', 'fixed', 'still-failing', 'info'];
  const groups = new Map<string, { raw: Raw; viewports: string[] }>();
  for (const r of raws) {
    const key = `${r.kind}\0${r.page}\0${r.text}\0${(r.lines ?? []).filter((l) => !/^(before|after|diff):/.test(l)).join('\n')}${r.lines?.some((l) => l.startsWith('diff:')) ? `\0${r.viewport}` : ''}`;
    const g = groups.get(key);
    if (g) g.viewports.push(r.viewport);
    else groups.set(key, { raw: r, viewports: [r.viewport] });
  }
  const findings: Finding[] = [...groups.values()]
    .sort((x, y) => order.indexOf(x.raw.kind) - order.indexOf(y.raw.kind))
    .map(({ raw, viewports }) => ({
      kind: raw.kind,
      title: `${raw.page} (${viewports.join(', ')}): ${raw.text}`,
      ...(raw.lines ? { lines: raw.lines } : {}),
      meta: { pages: [raw.page], viewports, ...(raw.images ? { images: raw.images, visualDiff: true } : {}) },
    }));

  const regressions = findings.filter((f) => f.kind === 'regression').length;
  const changes = findings.filter((f) => f.kind === 'change').length;
  const pages = new Set(after.results.map((r) => r.page)).size;
  const parts = [`${plural(pages, 'page')} checked`];
  if (regressions) parts.push(plural(regressions, 'regression'));
  if (visualChanges) parts.push(plural(visualChanges, 'visual difference'));
  const flaky = changes - visualChanges;
  if (flaky) parts.push(`${flaky} flaky`);
  if (!regressions && !changes) parts.push('no problems or visual differences');
  return {
    probeId: 'visual',
    title: o.title,
    status: regressions ? 'regressed' : changes ? 'changed' : 'ok',
    summary: parts.join(', '),
    findings,
  };
}

