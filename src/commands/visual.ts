import { loadConfig, type Config } from '../core/config.js';
import { HoldlineError } from '../core/errors.js';
import type { Io } from '../io.js';
import { isPageTemplate, normalisePagePath, resolvePageTemplate, type VisualCapture } from '../probes/visual/types.js';
import { describeVisualCapture, runVisual, visualSettingsFrom, writeVisualCapture } from '../probes/visual/index.js';
import { openProject } from './common.js';
import { plural } from '../plural.js';

export interface VisualOptions {
  json?: boolean;
  /** Pages to check instead of probes.visual.pages. */
  pages?: string[];
}

export interface VisualResult {
  status: VisualCapture['status'];
  message?: string;
  results: VisualCapture['results'];
  ms: number;
}

/** Run the visual check now (no snapshot, no comparison) and print what each page shows. */
export async function visualCommand(cwd: string, opts: VisualOptions, io: Io): Promise<VisualResult> {
  const { root } = await openProject(cwd);
  let config: Config | null = null;
  try {
    config = await loadConfig(root);
  } catch {
    /* works without `holdline init` */
  }
  const settings = visualSettingsFrom(config);
  if (opts.pages?.length) {
    settings.pages = [];
    for (const p of opts.pages) {
      let norm = normalisePagePath(p);
      if (!norm) throw new HoldlineError(`Not a page path on the app: ${p} (use paths like /about)`);
      if (isPageTemplate(norm)) {
        const res = resolvePageTemplate(norm, settings.params);
        if ('missing' in res) throw new HoldlineError(`${p} needs a value for ${res.missing.map((m) => `[${m}]`).join(', ')}: pass a concrete path or set probes.visual.params.`);
        norm = res.path;
      }
      const page = norm;
      if (!settings.pages.some((x) => x.path === page)) settings.pages.push({ path: page, mask: [] });
    }
  }
  if (settings.pages.length === 0) {
    throw new HoldlineError('No pages to check. List them in probes.visual.pages in .holdline/config.json, or pass them: holdline visual / /about');
  }
  const db = config?.probes?.database as { envVar?: unknown } | undefined;
  const capture = await runVisual({
    root,
    settings,
    packageManager: config?.packageManager ?? 'npm',
    mode: 'current',
    ...(typeof db?.envVar === 'string' ? { dbEnvVar: db.envVar } : {}),
    progress: (m) => io.progress(m),
  });
  io.progress('');
  await writeVisualCapture(root, 'current', capture);
  const result: VisualResult = { status: capture.status, ...(capture.message ? { message: capture.message } : {}), results: capture.results, ms: capture.ms };
  if (capture.status !== 'ok' && capture.message) io.warn(`Visual check: ${capture.message}`);
  if (!opts.json) printVisual(capture, io);
  return result;
}

function printVisual(c: VisualCapture, io: Io): void {
  const { c: col } = io;
  if (c.status !== 'ok') return;
  io.log(col.dim(`${describeVisualCapture(c)} (${(c.ms / 1000).toFixed(1)}s)`));
  for (const r of c.results) {
    io.log();
    const problems: string[] = [];
    if (!r.load.ok) problems.push(col.red(r.load.status ? `HTTP ${r.load.status}` : `did not load: ${r.load.error ?? 'error'}`));
    if (r.errorScreen) problems.push(col.red(`shows the ${r.errorScreen}`));
    if (r.blank) problems.push(col.red('blank'));
    const head = problems.length ? problems.join(', ') : col.green(r.load.status ? `HTTP ${r.load.status}` : 'loaded');
    io.log(`${col.bold(r.page)} ${col.dim(`(${r.viewport})`)}  ${head}  ${col.dim(`${(r.ms / 1000).toFixed(1)}s`)}`);
    for (const m of r.consoleErrors) io.log(`  ${col.yellow('console error')}: ${m}`);
    for (const m of r.pageErrors) io.log(`  ${col.yellow('uncaught error')}: ${m}`);
    for (const f of r.failedRequests) io.log(`  ${col.yellow('failed request')}: ${f.method} ${f.path} → ${f.status ?? f.failure}`);
    if (r.noisy?.length) io.log(col.dim(`  ${plural(r.noisy.length, 'region')} changed between two screenshots (live content); ignored when comparing`));
    if (r.screenshot) io.log(col.dim(`  screenshot: ${r.screenshot.file}`));
  }
}
