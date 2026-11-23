import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../../core/config.js';
import { HOLDLINE_DIR } from '../../core/store.js';
import { buildGraph, recallGraph } from '../dependencies/graph.js';
import { writeCompactJson } from '../dependencies/store.js';
import type { DepGraph } from '../dependencies/types.js';
import { tagOf, type Probe, type ProbeReport } from '../types.js';
import { compareApi } from './diff.js';
import type { DevServerPool } from '../devServer.js';
import { runLive } from './live.js';
import { API_CAPTURE_VERSION, apiSettings, type ApiCapture, type ApiRef, type ApiSettings, type LiveCapture } from './types.js';
import { plural } from '../../plural.js';

export function apiSettingsFrom(config: Config | null): ApiSettings {
  return apiSettings(config?.probes?.api as Record<string, unknown> | undefined);
}

export interface CaptureOptions {
  /** Reuse an already-built graph. */
  graph?: DepGraph;
  /** Run live mode when configured (needs a config). */
  live?: boolean;
  progress?: (msg: string) => void;
  signal?: AbortSignal;
  /** Shared dev servers for this run. */
  pool?: DevServerPool;
}

/** Static analysis of every route, plus live calls when configured. */
export async function captureApi(root: string, config: Config | null, opts: CaptureOptions = {}): Promise<{ capture: ApiCapture; graph: DepGraph }> {
  const settings = apiSettingsFrom(config);
  const graph = opts.graph ?? (await buildGraph(root, { projectType: config?.projectType }));
  let routes: ApiCapture['routes'] = {};
  let stats: ApiCapture['stats'] = { routes: 0, analysed: 0, unknown: 0, cached: 0, mode: 'none', ms: 0 };
  let warnings: string[] = [];
  if (Object.keys(graph.routes).length > 0) {
    // Loaded only for projects that have API routes.
    const { analyseApi } = await import('./analyse.js');
    ({ routes, stats, warnings } = await analyseApi(root, graph, { timeoutMs: settings.timeoutSec * 1000 }));
  }
  let live: LiveCapture = { status: 'off', results: [] };
  if (opts.live && config && settings.live.enabled) {
    const db = config.probes?.database as { envVar?: unknown } | undefined;
    live = await runLive({
      root,
      settings: settings.live,
      packageManager: config.packageManager,
      ...(typeof db?.envVar === 'string' ? { dbEnvVar: db.envVar } : {}),
      ...(opts.progress ? { progress: opts.progress } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.pool ? { pool: opts.pool } : {}),
    });
  }
  return { capture: { version: API_CAPTURE_VERSION, routes, live, warnings, stats }, graph };
}

// --- Storage (.holdline/api/api-<phase>.json) -------------------------------------------

export const apiCaptureFile = (root: string, phase: string) => path.join(root, HOLDLINE_DIR, 'api', `api-${phase}.json`);
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export async function writeApiCapture(root: string, phase: string, capture: ApiCapture): Promise<ApiRef> {
  const file = apiCaptureFile(root, phase);
  const text = await writeCompactJson(file, capture);
  return { file: path.relative(root, file).split(path.sep).join('/'), sha256: sha256(text), routes: Object.keys(capture.routes).length, live: capture.live.status };
}

export async function readApiCapture(root: string, ref: ApiRef | undefined): Promise<{ capture: ApiCapture } | { error: string }> {
  if (!ref || typeof ref.file !== 'string') return { error: 'no API capture recorded' };
  let text: string;
  try {
    text = await readFile(path.join(root, ref.file), 'utf8');
  } catch {
    return { error: `${ref.file} is missing` };
  }
  if (sha256(text) !== ref.sha256) return { error: `${ref.file} was changed or replaced since it was recorded` };
  try {
    const capture = JSON.parse(text) as ApiCapture;
    if (capture.version !== API_CAPTURE_VERSION) return { error: `${ref.file} was written by another holdline version` };
    return { capture };
  } catch {
    return { error: `${ref.file} is not valid JSON` };
  }
}

export function describeApiCapture(c: ApiCapture): string {
  const s = c.stats;
  if (s.routes === 0 && c.live.status === 'off') return 'no API routes';
  const parts = [`${plural(s.routes, 'route')}`];
  if (s.unknown) parts.push(`${s.unknown} not analysable`);
  if (s.cached) parts.push(`${s.cached} cached`);
  if (c.live.status === 'ok') parts.push(`live: ${plural(c.live.results.filter((r) => r.status !== undefined).length, 'request')}`);
  else if (c.live.status !== 'off') parts.push(`live: ${c.live.status}`);
  return parts.join(', ');
}

/** The "after" graph from snapshot(), reused by compare() in the same process. */
let lastAfter: { root: string; graph: DepGraph } | null = null;

export const apiProbe: Probe<ApiRef> = {
  id: 'api',
  title: 'API',

  enabled(config) {
    return config.probes?.api?.enabled !== false;
  },

  async snapshot(ctx) {
    ctx.io.progress('  API routes …');
    const started = Date.now();
    const known = recallGraph(ctx.root, ctx.snapshotSha);
    const { capture, graph } = await captureApi(ctx.root, ctx.config, { live: true, progress: (m) => ctx.io.progress(m), ...(known ? { graph: known } : {}), ...(ctx.devServers ? { pool: ctx.devServers } : {}) });
    if (ctx.phase === 'after') lastAfter = { root: ctx.root, graph };
    const ref = await writeApiCapture(ctx.root, tagOf(ctx), capture);
    ctx.io.progressDone(ctx.io.c.dim(`API: ${describeApiCapture(capture)} (${((Date.now() - started) / 1000).toFixed(1)}s)`));
    if (capture.live.status === 'refused' || capture.live.status === 'failed' || capture.live.status === 'skipped') ctx.io.warn(`Live API check${capture.live.status === 'skipped' ? ' skipped' : ''}: ${capture.live.message}`);
    for (const w of capture.warnings.slice(0, 3)) ctx.io.warn(`API: ${w}`);
    return ref;
  },

  async saveBaseline(ref) {
    return ref;
  },

  async restoreBaseline(kept, ctx) {
    const c = await readApiCapture(ctx.root, kept as ApiRef);
    return 'error' in c ? null : writeApiCapture(ctx.root, tagOf(ctx), c.capture);
  },

  async compare(beforeRef, afterRef, ctx): Promise<ProbeReport> {
    const skipped = (why: string): ProbeReport => ({ probeId: 'api', title: this.title, status: 'skipped', summary: why, findings: [] });
    const b = await readApiCapture(ctx.root, beforeRef);
    if ('error' in b) return skipped(`API capture from \`holdline before\` unavailable (${b.error}); run before again`);
    const a = await readApiCapture(ctx.root, afterRef);
    if ('error' in a) return skipped(`API capture from \`holdline after\` unavailable (${a.error})`);
    const noRoutes = Object.keys(b.capture.routes).length === 0 && Object.keys(a.capture.routes).length === 0;
    if (noRoutes && a.capture.live.status === 'off') return skipped('no API routes found');
    let graph: DepGraph | null = lastAfter?.root === ctx.root ? lastAfter.graph : null;
    if (!graph) {
      try {
        graph = await buildGraph(ctx.root, { projectType: ctx.config.projectType });
      } catch {
        graph = null;
      }
    }
    return compareApi(b.capture, a.capture, { root: ctx.root, graph, title: this.title });
  },
};
