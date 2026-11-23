import { loadConfig, type Config } from '../core/config.js';
import type { Io } from '../io.js';
import { matchRoute } from '../probes/dependencies/routes.js';
import { captureApi } from '../probes/api/index.js';
import { shapeText } from '../probes/api/shape.js';
import type { ApiCapture, MethodApi, RouteApi } from '../probes/api/types.js';
import { openProject } from './common.js';
import { plural } from '../plural.js';

export interface ApiOptions {
  json?: boolean;
  /** Only routes matching this path or pattern. */
  route?: string;
}

export interface ApiResult {
  routes: RouteApi[];
  live: ApiCapture['live'];
  stats: ApiCapture['stats'];
  warnings: string[];
}

export async function apiCommand(cwd: string, opts: ApiOptions, io: Io): Promise<ApiResult> {
  const { root } = await openProject(cwd);
  let config: Config | null = null;
  try {
    config = await loadConfig(root);
  } catch {
    /* works without `holdline init` (static analysis only) */
  }
  const { capture } = await captureApi(root, config, { live: true, progress: (m) => io.progress(m) });
  io.progress('');
  let routes = Object.values(capture.routes);
  if (opts.route) {
    const want = opts.route.startsWith('/') ? opts.route : `/${opts.route}`;
    routes = routes.filter((r) => r.pattern === want || matchRoute(want, r.pattern) >= 0);
  }
  const result: ApiResult = { routes, live: capture.live, stats: capture.stats, warnings: capture.warnings };
  if (capture.live.message && capture.live.status !== 'ok') result.warnings = [...result.warnings, `Live API check: ${capture.live.message}`];
  if (opts.json) for (const w of result.warnings) io.warn(w);
  else printApi(result, opts, io);
  return result;
}

const MAX_ROUTES = 500;

function printApi(r: ApiResult, opts: ApiOptions, io: Io): void {
  const { c } = io;
  for (const w of r.warnings) io.warn(w);
  if (r.routes.length === 0) {
    io.log(opts.route ? `No API route matches ${opts.route}.` : 'No API routes found (Next.js app/pages routers, Express/Fastify/Hono-style routes).');
  } else {
    const s = r.stats;
    io.log(
      c.dim(
        `${plural(s.routes, 'route')}${s.unknown ? `, ${s.unknown} not analysable` : ''} ` +
          `(static analysis${s.mode === 'syntax' ? ' from object literals only' : ''}, ${(s.ms / 1000).toFixed(1)}s${s.cached ? `, ${s.cached} cached` : ''})`,
      ),
    );
    for (const route of r.routes.slice(0, MAX_ROUTES)) printRoute(route, io);
    if (r.routes.length > MAX_ROUTES) io.log(c.dim(`\n…and ${plural(r.routes.length - MAX_ROUTES, 'more route')} (use --json for all)`));
  }
  if (r.live.status === 'ok') {
    io.log();
    io.log(c.bold('Live (dev server)'));
    for (const x of r.live.results) {
      if (x.error === 'skipped') io.log(`  ${x.method} ${x.path}  ${c.yellow(`skipped: ${x.note}`)}`);
      else if (x.status === undefined) io.log(`  ${x.method} ${x.path}  ${c.red(x.error ?? 'error')}`);
      else io.log(`  ${x.method} ${x.path}  ${statusPaint(io, x.status)}  ${x.shape === undefined || x.shape === null ? c.dim(x.contentType ?? '(no JSON body)') : shapeText(x.shape)}`);
    }
  }
}

function statusPaint(io: Io, s: number | 'unknown'): string {
  if (s === 'unknown') return io.c.yellow('???');
  return s < 300 ? io.c.green(String(s)) : s < 400 ? io.c.cyan(String(s)) : io.c.yellow(String(s));
}

function printRoute(route: RouteApi, io: Io): void {
  const { c } = io;
  io.log();
  const methods = Object.keys(route.methods);
  io.log(`${c.bold(route.pattern)}  ${c.dim(route.files.join(', '))}`);
  if (route.unknown) {
    io.log(`  ${c.yellow('unknown')}: ${route.unknown}`);
    return;
  }
  for (const m of methods) printMethod(m === '*' ? 'ALL' : m, route.methods[m]!, io);
}

function printMethod(m: string, api: MethodApi, io: Io): void {
  const { c } = io;
  io.log(`  ${c.cyan(m)}`);
  if (api.unknown) {
    io.log(`    ${c.yellow('unknown')}: ${api.unknown}`);
    return;
  }
  const req = api.request;
  const reqParts: string[] = [];
  if (req.params.length) reqParts.push(`params ${req.params.join(', ')}`);
  if (req.query.length) reqParts.push(`query ${req.query.join(', ')}`);
  if (req.body) reqParts.push(`body ${shapeText(req.body, 300)}`);
  if (reqParts.length) io.log(c.dim(`    request: ${reqParts.join('; ')}`));
  if (api.responses.length === 0) io.log(`    ${c.yellow('unknown')} ${c.dim('(no responses found)')}`);
  for (const r of api.responses) io.log(`    ${statusPaint(io, r.status)}  ${shapeText(r.body, 600)}`);
  const notes: string[] = [];
  if (!api.complete) notes.push('some responses could not be analysed');
  if (api.throws) notes.push('errors thrown are handled elsewhere');
  if (notes.length) io.log(c.dim(`    (${notes.join('; ')})`));
}
