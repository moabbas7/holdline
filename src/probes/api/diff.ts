/**
 * Compares two API captures. Breaking changes that callers will notice are regressions;
 * everything else is a change. Nothing that involves an unanalysable ("unknown") part is
 * ever a regression.
 */
import { categoryOf } from '../dependencies/format.js';
import { dependentsOf, indexGraph, type GraphIndex } from '../dependencies/graph.js';
import { matchRoute } from '../dependencies/routes.js';
import type { ApiCall, DepGraph } from '../dependencies/types.js';
import type { Finding, FindingMeta, ProbeReport } from '../types.js';
import { fieldRefs } from './fieldRefs.js';
import { diffShapes, pathText, shapeText, type ShapeChange } from './shape.js';
import type { ApiCapture, LiveRequestResult, MethodApi, RouteApi, Shape, Status } from './types.js';
import { plural } from '../../plural.js';

const MAX_CALL_LINES = 8;
const MAX_FIELD_LINES = 8;
const is2xx = (s: Status) => typeof s === 'number' && s >= 200 && s < 300;
const routeKey = (p: string) => p.replace(/:[^/]+/g, ':');
const methodLabel = (m: string) => (m === '*' ? 'ALL' : m);

export interface CompareContext {
  root: string;
  /** The dependency graph of the "after" state (callers). */
  graph: DepGraph | null;
  title?: string;
}

interface Pending {
  kind: 'regression' | 'change' | 'info';
  title: string;
  lines: string[];
  /** Fill in caller lines (and field lines) for these calls. */
  calls?: ApiCall[];
  field?: string[];
  maybeCalls?: ApiCall[];
  /** Route patterns the item is about (for scope classification). */
  routes?: string[];
}

export async function compareApi(b: ApiCapture, a: ApiCapture, ctx: CompareContext): Promise<ProbeReport> {
  const title = ctx.title ?? 'API';
  const graph = ctx.graph;
  const calls = graph?.apiCalls ?? [];
  const items: Pending[] = [];

  const bByKey = new Map(Object.values(b.routes).map((r) => [routeKey(r.pattern), r]));
  const aByKey = new Map(Object.values(a.routes).map((r) => [routeKey(r.pattern), r]));

  /** Calls that reach `route` in the after state with a method that `want` accepts. */
  const callsTo = (pattern: string, want: (m: string | undefined) => boolean) => calls.filter((c) => c.routes.includes(pattern) && want(c.method));

  /** Tag every item pushed since `from` with the route it is about. */
  const tag = (from: number, routes: string[]) => {
    for (let i = from; i < items.length; i++) items[i]!.routes ??= routes;
  };
  for (const [key, rb] of bByKey) {
    const start = items.length;
    const ra = aByKey.get(key);
    if (!ra) {
      // Removed: calls that no longer match any route but would have matched this one.
      const left = calls.filter((c) => c.routes.length === 0 && matchRoute(c.url, rb.pattern) >= 0);
      const methods = Object.keys(rb.methods).map(methodLabel).join('|');
      if (left.length) {
        items.push({ kind: 'regression', title: `Route removed: ${methods ? methods + ' ' : ''}${rb.pattern}, still called by ${plural(new Set(left.map((c) => c.file)).size, 'file')}`, lines: [], calls: left });
      } else {
        items.push({ kind: 'change', title: `Route removed: ${methods ? methods + ' ' : ''}${rb.pattern} (nothing in the project calls it)`, lines: [] });
      }
      tag(start, [rb.pattern]);
      continue;
    }
    compareRoute(rb, ra, items, callsTo);
    tag(start, [ra.pattern]);
  }
  for (const [key, ra] of aByKey) {
    if (bByKey.has(key)) continue;
    const methods = Object.keys(ra.methods).map(methodLabel).join('|');
    items.push({ kind: 'change', title: `New route: ${methods ? methods + ' ' : ''}${ra.pattern}${ra.unknown ? ` (not analysable: ${ra.unknown})` : ''}`, lines: [], routes: [ra.pattern] });
  }

  const liveStart = items.length;
  compareLive(b, a, items, graph);
  // Live results name a concrete path: match it to the known route patterns.
  const patterns = [...new Set([...Object.values(a.routes), ...Object.values(b.routes)].map((r) => r.pattern))];
  for (let i = liveStart; i < items.length; i++) {
    const p = /^\[live\] \S+ ([^?:\s]+)/.exec(items[i]!.title)?.[1];
    if (p) {
      const best = patterns.map((pat) => [pat, matchRoute(p, pat)] as const).filter(([, sc]) => sc >= 0).sort((x, y) => y[1] - x[1])[0];
      items[i]!.routes ??= best ? [best[0]] : [];
    }
  }

  // Caller details for regressions.
  const idx = graph ? indexGraph(graph) : null;
  const findings: Finding[] = [];
  for (const it of items) {
    const lines = [...it.lines];
    const meta: FindingMeta = { routes: it.routes ?? [] };
    if (it.calls?.length) {
      meta.affects = [...new Set(it.calls.map((c) => c.file))];
      meta.locations = it.calls.map((c) => ({ file: c.file, line: c.line, text: `calls ${c.method ? c.method + ' ' : ''}${c.url}` }));
    }
    if (it.calls?.length && graph && idx) {
      lines.push(...callerLines(graph, idx, it.calls));
      if (it.field && it.field.length) {
        const refs = await fieldRefs(ctx.root, it.calls, it.field, { limit: MAX_FIELD_LINES + 1 });
        for (const r of refs) if (r.exact) meta.locations!.push({ file: r.file, line: r.line, text: `reads ${pathText(it.field)}` });
        for (const r of refs.slice(0, MAX_FIELD_LINES)) {
          lines.push(r.exact ? `✗ ${r.file}:${r.line} reads ${pathText(it.field)} (${r.text})` : `? ${r.file}:${r.line} may read ${it.field.at(-1)} (${r.text})`);
        }
        if (refs.length > MAX_FIELD_LINES) lines.push('…and more lines');
      }
    }
    if (it.maybeCalls?.length) {
      for (const c of it.maybeCalls.slice(0, 4)) lines.push(`? ${c.file}:${c.line} calls ${c.url} with a method holdline can't determine`);
    }
    findings.push({ kind: it.kind, title: it.title, ...(lines.length ? { lines } : {}), meta });
  }
  findings.sort((x, y) => rank(x.kind) - rank(y.kind));
  for (const w of a.warnings.slice(0, 5)) findings.push({ kind: 'info', title: w });
  if (a.live.status === 'refused' || a.live.status === 'failed') findings.push({ kind: 'info', title: `Live API check: ${a.live.message ?? a.live.status}` });
  const liveSkipped = [b.live, a.live].find((l) => l.status === 'skipped');
  if (liveSkipped) findings.push({ kind: 'info', title: `Live API check skipped: ${liveSkipped.message ?? 'the dev server stopped itself'}` });

  const regressions = findings.filter((f) => f.kind === 'regression').length;
  const changes = findings.filter((f) => f.kind === 'change').length;
  const source = a.live.status === 'ok' && b.live.status === 'ok' ? 'static + live' : 'static';
  const nRoutes = Object.keys(a.routes).length;
  let summary: string;
  if (nRoutes === 0 && Object.keys(b.routes).length === 0 && a.live.results.length === 0) summary = 'no API routes found';
  else if (!regressions && !changes) summary = `no API changes (${plural(nRoutes, 'route')}, ${source})`;
  else {
    const parts: string[] = [];
    if (regressions) parts.push(plural(regressions, 'breaking API change'));
    if (changes) parts.push(plural(changes, 'other API change'));
    summary = `${parts.join(', ')} (${plural(nRoutes, 'route')}, ${source})`;
  }
  if (liveSkipped) summary += `; live check skipped: ${/^Next\.js stopped/.test(liveSkipped.message ?? '') ? 'Next.js stopped its dev server for the AI agent (see below)' : (liveSkipped.message ?? '')}`;
  return {
    probeId: 'api',
    title,
    status: regressions ? 'regressed' : changes ? 'changed' : nRoutes === 0 && a.live.results.length === 0 ? 'skipped' : 'ok',
    summary,
    findings,
  };
}

const rank = (k: Finding['kind']) => (k === 'regression' ? 0 : k === 'change' ? 1 : 2);

function handles(r: RouteApi, m: string | undefined): boolean {
  if (!m) return false;
  return m in r.methods || '*' in r.methods || (m === 'HEAD' && 'GET' in r.methods);
}

function compareRoute(
  rb: RouteApi,
  ra: RouteApi,
  items: Pending[],
  callsTo: (pattern: string, want: (m: string | undefined) => boolean) => ApiCall[],
): void {
  const where = ra.pattern;
  if (rb.unknown || ra.unknown) {
    if (!rb.unknown && ra.unknown) items.push({ kind: 'change', title: `${where} can no longer be analysed (${ra.unknown}); its responses are not compared`, lines: [] });
    else if (rb.unknown && !ra.unknown) items.push({ kind: 'change', title: `${where} can now be analysed (it couldn't before: ${rb.unknown})`, lines: [] });
    return;
  }
  // Methods removed / added.
  for (const m of Object.keys(rb.methods)) {
    if (m in ra.methods) continue;
    if (m !== '*' && '*' in ra.methods) continue;
    const lost = (cm: string | undefined) => (m === '*' ? cm !== undefined && !handles(ra, cm) : cm === m || (m === 'GET' && cm === 'HEAD'));
    const callers = callsTo(ra.pattern, lost);
    const maybe = callsTo(ra.pattern, (cm) => cm === undefined);
    const label = m === '*' ? `methods other than ${Object.keys(ra.methods).join(', ')}` : m;
    if (callers.length) {
      items.push({ kind: 'regression', title: `${where} no longer handles ${label}, still called by ${plural(new Set(callers.map((c) => c.file)).size, 'file')}`, lines: [], calls: callers });
    } else {
      items.push({ kind: 'change', title: `${where} no longer handles ${label} (nothing in the project calls it${maybe.length ? ' with that method as far as holdline can tell' : ''})`, lines: [], ...(maybe.length ? { maybeCalls: maybe } : {}) });
    }
  }
  for (const m of Object.keys(ra.methods)) {
    if (!(m in rb.methods)) items.push({ kind: 'change', title: `${methodLabel(m)} ${where}: new method`, lines: [] });
  }
  for (const [m, mb] of Object.entries(rb.methods)) {
    const ma = ra.methods[m];
    if (!ma) continue;
    const callers = () => callsTo(ra.pattern, (cm) => m === '*' || cm === m || (m === 'GET' && cm === 'HEAD'));
    compareMethod(`${methodLabel(m)} ${where}`, m, mb, ma, items, callers);
  }
}

function compareMethod(label: string, method: string, mb: MethodApi, ma: MethodApi, items: Pending[], callers: () => ApiCall[]): void {
  if (mb.unknown || ma.unknown) {
    if (!mb.unknown && ma.unknown) items.push({ kind: 'change', title: `${label} can no longer be analysed (${ma.unknown})`, lines: [] });
    return;
  }
  // --- Status codes -----------------------------------------------------------------------
  const sb = mb.responses.filter((r) => r.status !== 'unknown');
  const sa = ma.responses.filter((r) => r.status !== 'unknown');
  const ok = (list: typeof sb) => new Set(list.filter((r) => is2xx(r.status)).map((r) => r.status as number));
  const okB = ok(sb);
  const okA = ok(sa);
  const allB = new Set(sb.map((r) => r.status));
  const allA = new Set(sa.map((r) => r.status));
  const gone2xx = [...okB].filter((s) => !okA.has(s));
  const new2xx = [...okA].filter((s) => !okB.has(s));
  const newOther = [...allA].filter((s) => !allB.has(s) && !is2xx(s));
  const goneOther = [...allB].filter((s) => !allA.has(s) && !is2xx(s));
  const list = (xs: Status[]) => xs.join(', ');
  const at = (s: Status) => ma.responses.find((r) => r.status === s)?.at[0];
  if (okB.size && okA.size === 0 && ma.complete && (sa.length > 0 || ma.throws)) {
    const now = sa.length ? `it now returns only ${list([...allA])}` : 'it now only throws';
    items.push({
      kind: 'regression',
      title: `${label} no longer returns a success response (was ${list([...okB])}; ${now})`,
      lines: sa.length ? [`returned at ${sa.flatMap((r) => r.at).slice(0, 3).join(', ')}`] : [],
      calls: callers(),
    });
  } else if (gone2xx.length && newOther.length && ma.complete) {
    items.push({
      kind: 'regression',
      title: `${label}: the ${list(gone2xx)} response was replaced by ${list(newOther)}`,
      lines: newOther.map((s) => at(s)).filter(Boolean).map((x) => `returned at ${x}`),
      calls: callers(),
    });
  } else {
    if (gone2xx.length && new2xx.length) items.push({ kind: 'change', title: `${label}: success status ${list(gone2xx)} → ${list(new2xx)}`, lines: [] });
    else {
      if (gone2xx.length) items.push({ kind: 'change', title: `${label}: no longer returns ${list(gone2xx)}`, lines: [] });
      if (new2xx.length) items.push({ kind: 'change', title: `${label}: now also returns ${list(new2xx)}`, lines: [] });
    }
    if (newOther.length) items.push({ kind: 'change', title: `${label}: can now return ${list(newOther)}`, lines: [] });
  }
  if (goneOther.length) items.push({ kind: 'change', title: `${label}: no longer returns ${list(goneOther)}`, lines: [] });

  // --- Response bodies --------------------------------------------------------------------
  const pairs: [Status, Shape | null, Shape | null][] = [];
  for (const r of sb) {
    const other = sa.find((x) => x.status === r.status);
    if (other) pairs.push([r.status, r.body, other.body]);
  }
  if (okB.size === 1 && okA.size === 1 && gone2xx.length === 1) {
    pairs.push([[...okA][0]!, sb.find((r) => r.status === gone2xx[0])!.body, sa.find((r) => is2xx(r.status))!.body]);
  }
  for (const [status, bb, ba] of pairs) {
    const sl = `${label} (${status})`;
    if (bb && !ba) {
      items.push({ kind: is2xx(status) ? 'regression' : 'change', title: `${sl}: the response is no longer JSON (was ${shapeText(bb, 120)})`, lines: [], calls: is2xx(status) ? callers() : undefined });
      continue;
    }
    if (!bb && ba) {
      items.push({ kind: 'change', title: `${sl}: now returns JSON ${shapeText(ba, 120)}`, lines: [] });
      continue;
    }
    if (!bb || !ba) continue;
    for (const c of diffShapes(bb, ba)) items.push(responseItem(sl, c, callers));
  }

  // --- Request ----------------------------------------------------------------------------
  compareRequest(label, method, mb, ma, items, callers);
}

function responseItem(label: string, c: ShapeChange, callers: () => ApiCall[]): Pending {
  const f = pathText(c.path);
  switch (c.kind) {
    case 'field-removed':
      return { kind: 'regression', title: `${label}: response field "${f}" removed (was ${c.from})`, lines: [], calls: callers(), field: c.path };
    case 'type-changed':
      return { kind: 'regression', title: `${label}: response field "${f}" changed type: ${c.from} → ${c.to}`, lines: [], calls: callers(), field: c.path };
    case 'field-added':
      return { kind: 'change', title: `${label}: response field "${f}" added (${c.to})`, lines: [] };
    case 'became-optional':
      return { kind: 'change', title: `${label}: response field "${f}" is now optional`, lines: [] };
    case 'became-required':
      return { kind: 'change', title: `${label}: response field "${f}" is now always present`, lines: [] };
    default:
      return { kind: 'change', title: `${label}: ${c.path.length ? `response field "${f}"` : 'response body'} can no longer be fully analysed (${c.from} → ${c.to})`, lines: [] };
  }
}

function compareRequest(label: string, method: string, mb: MethodApi, ma: MethodApi, items: Pending[], callers: () => ApiCall[]): void {
  const rb = mb.request;
  const ra = ma.request;
  for (const q of ra.query) if (!rb.query.includes(q)) items.push({ kind: 'change', title: `${label}: reads new query parameter "${q}"`, lines: [] });
  for (const q of rb.query) if (!ra.query.includes(q)) items.push({ kind: 'change', title: `${label}: no longer reads query parameter "${q}"`, lines: [] });
  const ob = rb.body?.k === 'object' ? rb.body : null;
  const oa = ra.body?.k === 'object' ? ra.body : null;
  if (!oa) {
    if (rb.body && !ra.body) items.push({ kind: 'change', title: `${label}: no longer reads a request body`, lines: [] });
    return;
  }
  if (rb.body && !ob) return; // before: an unknown body
  const tightened: { field: string; why: string }[] = [];
  for (const [k, fa] of Object.entries(oa.fields)) {
    if (fa.optional !== false) continue;
    const fb = ob?.fields[k];
    if (fb && fb.optional === true) tightened.push({ field: k, why: 'was optional, now required' });
    else if (!fb && !ob?.open) tightened.push({ field: k, why: 'new required field' });
  }
  if (tightened.length) {
    const cs = method === 'GET' ? [] : callers();
    for (const t of tightened) {
      const title = `${label}: request body field "${t.field}" is required (${t.why})`;
      if (cs.length) items.push({ kind: 'regression', title: `${title}; ${plural(new Set(cs.map((c) => c.file)).size, 'caller')} may not send it`, lines: [], calls: cs });
      else items.push({ kind: 'change', title: `${title} (nothing in the project calls it)`, lines: [] });
    }
  }
  if (ob) {
    for (const [k, fb] of Object.entries(ob.fields)) {
      const fa = oa.fields[k];
      if (!fa) {
        if (!oa.open) items.push({ kind: 'change', title: `${label}: request body field "${k}" is no longer read`, lines: [] });
        continue;
      }
      if (fb.optional === false && fa.optional === true) items.push({ kind: 'change', title: `${label}: request body field "${k}" is now optional`, lines: [] });
      for (const c of diffShapes(fb.shape, fa.shape)) {
        if (c.kind === 'type-changed') items.push({ kind: 'change', title: `${label}: request body field "${pathText([k, ...c.path.slice(0)])}" changed type: ${c.from} → ${c.to}`, lines: [] });
      }
    }
    for (const [k, fa] of Object.entries(oa.fields)) {
      if (!ob.fields[k] && fa.optional !== false) items.push({ kind: 'change', title: `${label}: reads new${fa.optional === true ? ' optional' : ''} request body field "${k}"`, lines: [] });
    }
  }
}

/** One line per direct call, then the pages that depend on the calling files. */
function callerLines(graph: DepGraph, idx: GraphIndex, calls: ApiCall[]): string[] {
  const lines: string[] = [];
  const sorted = [...calls].sort((x, y) => x.file.localeCompare(y.file) || x.line - y.line);
  for (const c of sorted.slice(0, MAX_CALL_LINES)) {
    const role = graph.files[c.file]?.role === 'page' ? 'page ' : '';
    lines.push(`${role}${c.file}:${c.line} calls ${c.method ? c.method + ' ' : ''}${c.url}`);
  }
  if (sorted.length > MAX_CALL_LINES) lines.push(`…and ${plural(sorted.length - MAX_CALL_LINES, 'more call')}`);
  const direct = new Set(calls.map((c) => c.file));
  const pages = new Set<string>();
  for (const f of direct) {
    for (const d of dependentsOf(idx, f, 6)) if (categoryOf(graph, d.node) === 'page' && !direct.has(d.node)) pages.add(d.node);
  }
  if (pages.size) {
    const list = [...pages].sort();
    lines.push(`used by ${plural(list.length, 'page')}: ${list.slice(0, 6).join(', ')}${list.length > 6 ? ', …' : ''}`);
  }
  return lines;
}

// --- Live --------------------------------------------------------------------------------

function compareLive(b: ApiCapture, a: ApiCapture, items: Pending[], graph: DepGraph | null): void {
  if (b.live.status !== 'ok' || a.live.status !== 'ok') return;
  const key = (r: LiveRequestResult) => `${r.method} ${r.path}`;
  const after = new Map(a.live.results.map((r) => [key(r), r]));
  const callersFor = (r: LiveRequestResult): ApiCall[] => {
    if (!graph?.apiCalls) return [];
    const p = r.path.split('?')[0]!;
    const routes = Object.keys(graph.routes).filter((pat) => matchRoute(p, pat) >= 0);
    return graph.apiCalls.filter((c) => c.routes.some((x) => routes.includes(x)) && c.method === r.method);
  };
  for (const rb of b.live.results) {
    const ra = after.get(key(rb));
    if (!ra || rb.status === undefined) continue;
    const label = `[live] ${key(rb)}`;
    if (ra.status === undefined) {
      items.push({ kind: 'change', title: `${label}: could not be called after the task (${ra.error ?? 'error'})`, lines: [] });
      continue;
    }
    if (rb.status !== ra.status) {
      if (is2xx(rb.status) && !is2xx(ra.status)) items.push({ kind: 'regression', title: `${label}: returned ${rb.status}, now ${ra.status}`, lines: [], calls: callersFor(rb) });
      else items.push({ kind: 'change', title: `${label}: status ${rb.status} → ${ra.status}`, lines: [] });
      if (is2xx(rb.status) !== is2xx(ra.status)) continue;
    }
    if (rb.shape && ra.shape) {
      for (const c of diffShapes(rb.shape, ra.shape, { loose: true })) {
        if (c.kind === 'field-removed' || c.kind === 'type-changed') {
          const it = responseItem(`${label} (${ra.status})`, c, () => callersFor(rb));
          items.push(it);
        } else if (c.kind === 'field-added') items.push({ kind: 'change', title: `${label} (${ra.status}): response field "${pathText(c.path)}" added (${c.to})`, lines: [] });
      }
    } else if (rb.shape && !ra.shape) {
      items.push({ kind: 'regression', title: `${label}: the response is no longer JSON`, lines: [], calls: callersFor(rb) });
    }
  }
}
