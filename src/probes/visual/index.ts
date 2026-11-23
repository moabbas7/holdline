/**
 * The visual probe (opt-in): load the configured pages in headless Chromium at desktop and
 * mobile widths and record screenshots, console and uncaught errors, failed requests to the
 * app's own origin, and blank or error screens. Playwright is optional and loaded lazily.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Config, PackageManager } from '../../core/config.js';
import { readSession } from '../../core/session.js';
import { HOLDLINE_DIR } from '../../core/store.js';
import { writeCompactJson } from '../dependencies/store.js';
import { DevServerPool } from '../devServer.js';
import type { Probe, ProbeReport } from '../types.js';
import { VISUAL_CAPTURE_VERSION, visualSettings, type PageResult, type VisualCapture, type VisualRef, type VisualSettings } from './types.js';

export function visualSettingsFrom(config: Config | null): VisualSettings {
  const live = (config?.probes?.api as { live?: Record<string, unknown> } | undefined)?.live;
  return visualSettings(config?.probes?.visual as Record<string, unknown> | undefined, live);
}

export const visualDir = (root: string) => path.join(root, HOLDLINE_DIR, 'visual');
export type VisualMode = 'before' | 'after' | 'current';
const captureFile = (root: string, mode: VisualMode) => path.join(visualDir(root), `visual-${mode}.json`);

export interface RunVisualOptions {
  root: string;
  settings: VisualSettings;
  packageManager: PackageManager;
  mode: VisualMode;
  /** probes.database.envVar */
  dbEnvVar?: string;
  /** Shared dev servers for this run; without one a private pool is used and disposed. */
  pool?: DevServerPool;
  /** after: the "before" results, to confirm new problems. */
  before?: PageResult[];
  env?: NodeJS.ProcessEnv;
  progress?: (msg: string) => void;
}

/** Run the visual check. Never throws: problems become the capture's status and message. */
export async function runVisual(o: RunVisualOptions): Promise<VisualCapture> {
  const started = Date.now();
  const done = (status: VisualCapture['status'], message?: string, results: PageResult[] = []): VisualCapture => ({
    version: VISUAL_CAPTURE_VERSION,
    status,
    ...(message ? { message } : {}),
    results,
    ms: Date.now() - started,
  });
  if (o.settings.pages.length === 0) return done('off', 'no pages listed in probes.visual.pages');

  const { loadPlaywright, launchChromium } = await import('./playwright.js');
  const pw = loadPlaywright(o.root, o.packageManager);
  if (!pw.ok) return done('unavailable', pw.message);

  const { capturePages, checkStorageState, loadStorageState } = await import('./capture.js');
  const state = await checkStorageState(o.root, o.settings.storageState);
  if (!state.ok) return done('refused', `visual check not run: ${state.message}`);

  const pool = o.pool ?? new DevServerPool();
  try {
    const server = await pool.acquire({
      root: o.root,
      ...(o.settings.command ? { command: o.settings.command } : {}),
      packageManager: o.packageManager,
      startupTimeoutSec: o.settings.startupTimeoutSec,
      commandSetting: 'probes.visual.command',
      ...(o.env ? { env: o.env } : {}),
      ...(o.progress ? { progress: o.progress } : {}),
      allowNonLocalDatabase: o.settings.allowNonLocalDatabase,
      ...(o.dbEnvVar ? { dbEnvVar: o.dbEnvVar } : {}),
      settingKey: 'probes.visual.allowNonLocalDatabase',
      what: 'the visual check',
    });
    if (!server.ok) return done(server.status, server.message);

    const stoppedMessage = () => {
      const code = server.exited();
      return code === undefined ? null : `the dev server (${server.command}) exited with code ${code} while pages were being checked, so the results were discarded. Run it yourself to see why.`;
    };
    const origin = `http://localhost:${server.port}`;
    let storageState: Awaited<ReturnType<typeof loadStorageState>> | null = null;
    if (state.path) {
      storageState = await loadStorageState(state.path, o.settings.storageState!, origin);
      if (!storageState.ok) return done('refused', `visual check not run: ${storageState.message}`);
    }
    const launched = await launchChromium(pw.chromium, o.packageManager);
    if (!launched.ok) return done(/not installed/.test(launched.message) ? 'unavailable' : 'failed', launched.message);
    try {
      const results = await capturePages({
        root: o.root,
        browser: launched.browser,
        // Browse as "localhost": dev servers such as Next.js block their dev resources (HMR
        // websocket, overlays) for other host names like 127.0.0.1.
        origin,
        settings: o.settings,
        mode: o.mode,
        outDir: path.join(visualDir(o.root), o.mode),
        ...(storageState?.ok ? { storageState: storageState.state } : {}),
        ...(o.before ? { before: o.before } : {}),
        ...(o.progress ? { progress: o.progress } : {}),
      });
      // A server that died mid-run would make every page look broken: discard the results.
      const stopped = stoppedMessage();
      if (stopped) return done('failed', stopped);
      return done('ok', undefined, results);
    } finally {
      await launched.browser.close().catch(() => {});
    }
  } catch (e) {
    return done('failed', `the visual check failed: ${((e as Error).message ?? String(e)).split('\n')[0]}`);
  } finally {
    if (!o.pool) await pool.dispose();
  }
}

// --- Storage -------------------------------------------------------------------------------------

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export async function writeVisualCapture(root: string, mode: VisualMode, capture: VisualCapture): Promise<VisualRef> {
  const file = captureFile(root, mode);
  const text = await writeCompactJson(file, capture);
  return { file: path.relative(root, file).split(path.sep).join('/'), sha256: sha256(text), status: capture.status, pages: new Set(capture.results.map((r) => r.page)).size };
}

export async function readVisualCapture(root: string, ref: VisualRef | undefined): Promise<{ capture: VisualCapture } | { error: string }> {
  if (!ref || typeof ref.file !== 'string') return { error: 'no visual capture recorded' };
  let text: string;
  try {
    text = await readFile(path.join(root, ref.file), 'utf8');
  } catch {
    return { error: `${ref.file} is missing` };
  }
  if (sha256(text) !== ref.sha256) return { error: `${ref.file} was changed or replaced since it was recorded` };
  try {
    const capture = JSON.parse(text) as VisualCapture;
    if (capture.version !== VISUAL_CAPTURE_VERSION) return { error: `${ref.file} was written by another holdline version` };
    return { capture };
  } catch {
    return { error: `${ref.file} is not valid JSON` };
  }
}

export function describeVisualCapture(c: VisualCapture): string {
  if (c.status !== 'ok') return c.status;
  const pages = new Set(c.results.map((r) => r.page)).size;
  const problems = c.results.filter((r) => !r.load.ok || r.blank || r.errorScreen || r.consoleErrors.length || r.pageErrors.length || r.failedRequests.length).length;
  return `${pages} page${pages === 1 ? '' : 's'} × 2 viewports${problems ? `, ${problems} with problems` : ''}`;
}

// --- Probe ---------------------------------------------------------------------------------------

export const visualProbe: Probe<VisualRef> = {
  id: 'visual',
  title: 'Visual',

  enabled(config) {
    const s = visualSettingsFrom(config);
    return s.enabled && s.pages.length > 0;
  },

  async snapshot(ctx) {
    const started = Date.now();
    const settings = visualSettingsFrom(ctx.config);
    for (const u of settings.unresolved) {
      ctx.io.warn(`Visual check: skipping ${u.template}: no sample value for ${u.missing.map((m) => `[${m}]`).join(', ')}. Set probes.visual.params (e.g. { "${u.missing[0]}": "…" }) in .holdline/config.json.`);
    }
    ctx.io.progress('  visual check …');
    let before: PageResult[] | undefined;
    if (ctx.phase === 'after') {
      const session = await readSession(ctx.root);
      const prev = await readVisualCapture(ctx.root, session?.probes?.visual as VisualRef | undefined);
      if ('capture' in prev && prev.capture.status === 'ok') before = prev.capture.results;
    }
    const db = ctx.config.probes?.database as { envVar?: unknown } | undefined;
    const capture = await runVisual({
      root: ctx.root,
      settings,
      packageManager: ctx.config.packageManager,
      mode: ctx.phase,
      ...(typeof db?.envVar === 'string' ? { dbEnvVar: db.envVar } : {}),
      ...(ctx.devServers ? { pool: ctx.devServers } : {}),
      ...(before ? { before } : {}),
      progress: (m) => ctx.io.progress(m),
    });
    const ref = await writeVisualCapture(ctx.root, ctx.phase, capture);
    ctx.io.progressDone(ctx.io.c.dim(`Visual: ${describeVisualCapture(capture)} (${((Date.now() - started) / 1000).toFixed(1)}s)`));
    if (capture.status !== 'ok' && capture.message) ctx.io.warn(`Visual check: ${capture.message}`);
    return ref;
  },

  async compare(beforeRef, afterRef, ctx): Promise<ProbeReport> {
    const skipped = (why: string): ProbeReport => ({ probeId: 'visual', title: this.title, status: 'skipped', summary: why, findings: [] });
    const b = await readVisualCapture(ctx.root, beforeRef);
    if ('error' in b) return skipped(`visual capture from \`holdline before\` unavailable (${b.error}); run before again`);
    const a = await readVisualCapture(ctx.root, afterRef);
    if ('error' in a) return skipped(`visual capture from \`holdline after\` unavailable (${a.error})`);
    if (b.capture.status !== 'ok') return skipped(`not run in \`holdline before\`: ${b.capture.message ?? b.capture.status}`);
    if (a.capture.status !== 'ok') return skipped(`not run: ${a.capture.message ?? a.capture.status}`);
    const { compareVisual } = await import('./compare.js');
    return compareVisual(b.capture, a.capture, {
      root: ctx.root,
      title: this.title,
      threshold: visualSettingsFrom(ctx.config).threshold,
      minPixels: visualSettingsFrom(ctx.config).minPixels,
      diffDir: path.join(visualDir(ctx.root), 'diff'),
    });
  },
};
