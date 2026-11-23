import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ProjectType } from '../../core/config.js';
import { gitMaybe, splitNul } from '../../core/git.js';
import { loadFacts } from './cache.js';
import { joinUrl } from './extract.js';
import { listFiles } from './files.js';
import { Resolver, type Resolution } from './resolve.js';
import { joinRoute, matchRoute, nextFileRole } from './routes.js';
import { TsconfigResolver } from './tsconfigs.js';
import {
  routeId,
  tableId,
  type BrokenImport,
  type DepGraph,
  type ApiCall,
  type Edge,
  type FileFacts,
  type RouteHandler,
  type ImportFact,
} from './types.js';
import { loadPackageJsons, workspacePackages } from './workspaces.js';

export interface BuildOptions {
  projectType?: ProjectType;
  /** Override for tests: a different version invalidates the cache. */
  extractorVersion?: number;
}

const ROUTER_RECEIVER = /^(app|router|server|routes?|\w+Router)$/;
const NEXT_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const MAX_AMBIGUOUS_MATCHES = 3;
const PRISMA_RECEIVER =/prisma|^db$|^tx$|\.db$/i;
const PROBE_EXTS = ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.d.ts', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];

class EdgeSet {
  private keys = new Set<string>();
  readonly list: Edge[] = [];
  add(e: Edge): void {
    const k = `${e.from}\0${e.to}\0${e.type}`;
    if (this.keys.has(k)) return;
    this.keys.add(k);
    this.list.push(e);
  }
}

/** The last graph built per snapshot, so other probes in the same run can reuse it. */
let remembered: { root: string; snapshotSha: string; graph: DepGraph } | null = null;

export function rememberGraph(root: string, snapshotSha: string, graph: DepGraph): void {
  remembered = { root, snapshotSha, graph };
}

/** The graph the dependencies probe built for this exact snapshot in this process, if any. */
export function recallGraph(root: string, snapshotSha: string): DepGraph | null {
  return remembered && remembered.root === root && remembered.snapshotSha === snapshotSha ? remembered.graph : null;
}

/** Build the dependency graph of the working tree at `root`. */
export async function buildGraph(root: string, opts: BuildOptions = {}): Promise<DepGraph> {
  const started = Date.now();
  const listing = await listFiles(root);
  const loaded = await loadFacts(root, listing.analysed, { extractorVersion: opts.extractorVersion });
  const facts = loaded.facts;
  const analysed = new Map([...listing.analysed].filter(([p]) => facts.has(p)));

  const packages = await loadPackageJsons(root, listing.all);
  const pnpmYaml = listing.all.has('pnpm-workspace.yaml')
    ? readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8')
    : null;
  const workspaces = workspacePackages(packages, pnpmYaml);
  const tsconfigs = new TsconfigResolver(root, listing.all, workspaces);
  const resolver = new Resolver(listing.all, analysed, tsconfigs, workspaces);

  const files: DepGraph['files'] = {};
  for (const [p, hash] of [...loaded.hashes].sort(([a], [b]) => a.localeCompare(b))) {
    files[p] = { hash, role: analysed.get(p) === 'source' ? 'module' : 'schema' };
  }
  const edges = new EdgeSet();
  const resolveIn = (file: string, spec: string): Resolution => resolver.resolve(file, spec);
  const factsOf = (file: string): FileFacts | undefined => facts.get(file);

  // --- 1. Imports ------------------------------------------------------------------------
  const missing: { file: string; imp: ImportFact; candidates: string[] }[] = [];
  for (const [file, f] of facts) {
    for (const imp of f.imports) {
      const r = resolveIn(file, imp.spec);
      if (r.kind === 'file') {
        if (r.path !== file) {
          edges.add({ from: file, to: r.path, type: factsOf(r.path)?.useServer ? 'server-action' : 'import', line: imp.line });
        }
      } else if (r.kind === 'missing') {
        missing.push({ file, imp, candidates: r.candidates });
      }
    }
  }

  // --- 2. Broken imports -----------------------------------------------------------------
  const broken: BrokenImport[] = [];
  for (const m of await dropGenerated(root, missing)) {
    broken.push({ file: m.file, spec: m.imp.spec, line: m.imp.line, reason: 'missing-file' });
  }
  const exportsMemo = new Map<string, { names: Set<string>; complete: boolean }>();
  const exportsOf = (file: string, seen = new Set<string>()): { names: Set<string>; complete: boolean } => {
    const memo = exportsMemo.get(file);
    if (memo) return memo;
    const f = factsOf(file);
    if (!f || seen.has(file)) return { names: new Set(), complete: false };
    seen.add(file);
    const names = new Set(f.exports);
    let complete = !(f.hasCjs && f.exports.length === 0);
    for (const spec of f.starExports) {
      const r = resolveIn(file, spec);
      if (r.kind !== 'file') {
        complete = false;
        continue;
      }
      const sub = exportsOf(r.path, seen);
      if (!sub.complete) complete = false;
      for (const n of sub.names) if (n !== 'default') names.add(n);
    }
    const result = { names, complete };
    exportsMemo.set(file, result);
    return result;
  };
  for (const [file, f] of facts) {
    for (const imp of f.imports) {
      if ((imp.kind !== 'import' && imp.kind !== 'reexport') || imp.names.length === 0) continue;
      const r = resolveIn(file, imp.spec);
      if (r.kind !== 'file') continue;
      const target = factsOf(r.path)!;
      const ex = exportsOf(r.path);
      if (!ex.complete) continue;
      for (const name of imp.names) {
        if (name === '*' || ex.names.has(name)) continue;
        if (name === 'default' && target.hasCjs) continue;
        broken.push({ file, spec: imp.spec, line: imp.line, reason: 'missing-export', name, target: r.path });
      }
    }
  }

  // --- 3. Pages, Next.js API routes, server actions ------------------------------------
  const routes = new Map<string, { files: Set<string>; methods: Set<string>; handlers: RouteHandler[] }>();
  const addRoute = (pattern: string, file: string, methods: string[], handler: RouteHandler) => {
    let r = routes.get(pattern);
    if (!r) routes.set(pattern, (r = { files: new Set(), methods: new Set(), handlers: [] }));
    r.files.add(file);
    for (const m of methods) r.methods.add(m);
    if (!r.handlers.some((h) => h.file === handler.file && h.line === handler.line && h.method === handler.method)) r.handlers.push(handler);
    files[file]!.role = 'api-route';
  };
  const nextRoots = [...packages]
    .filter(([, pkg]) => 'next' in { ...pkg.dependencies, ...pkg.devDependencies })
    .map(([dir]) => dir);
  if (opts.projectType === 'nextjs' && !nextRoots.includes('')) nextRoots.push('');
  nextRoots.sort((a, b) => b.length - a.length);

  for (const [file, f] of facts) {
    if (analysed.get(file) !== 'source') continue;
    const nextRoot = nextRoots.find((r) => r === '' || file.startsWith(r + '/'));
    if (nextRoot !== undefined) {
      const role = nextFileRole(nextRoot === '' ? file : file.slice(nextRoot.length + 1));
      if (role?.kind === 'api') {
        const rel = nextRoot === '' ? file : file.slice(nextRoot.length + 1);
        const kind = /^(?:src\/)?pages\//.test(rel) ? 'next-pages' : 'next-app';
        addRoute(role.pattern, file, f.exports.filter((e) => NEXT_METHODS.includes(e)), { file, kind });
      }
      else if (role?.kind === 'page') files[file]!.role = 'page';
    }
    if (f.useServer && files[file]!.role === 'module') files[file]!.role = 'server-action';
  }

  // --- 4. HTTP client calls, Express-style routes and mounts ---------------------------
  const bindingOf = (file: string, local: string): { target: string; imported: string } | null => {
    for (const imp of factsOf(file)?.imports ?? []) {
      for (const [l, imported] of imp.bindings) {
        if (l !== local) continue;
        const r = resolveIn(file, imp.spec);
        return r.kind === 'file' ? { target: r.path, imported } : null;
      }
    }
    return null;
  };
  const axiosBase = (file: string, local: string): string | undefined => {
    const own = factsOf(file)?.axiosInstances[local];
    if (own !== undefined) return own;
    const b = bindingOf(file, local);
    if (!b) return undefined;
    const tf = factsOf(b.target)!;
    const name = b.imported === 'default' || b.imported === '*' ? tf.exportLocals.default : (tf.exportLocals[b.imported] ?? b.imported);
    return name !== undefined ? tf.axiosInstances[name] : undefined;
  };

  const calls: { file: string; url: string; line: number; method?: string }[] = [];
  const routeDefs: { file: string; receiver: string; method: string; url: string; line: number }[] = [];
  for (const [file, f] of facts) {
    for (const c of f.httpCalls) calls.push({ file, url: c.url, line: c.line, ...(c.method ? { method: c.method } : {}) });
    for (const mc of f.methodCalls) {
      const base = axiosBase(file, mc.receiver);
      if (base !== undefined) {
        calls.push({ file, url: joinUrl(base, mc.url), line: mc.line, ...(mc.method !== 'request' ? { method: mc.method.toUpperCase() } : {}) });
      } else if (mc.pathLike && mc.hasHandlerArg && (f.serverFramework || ROUTER_RECEIVER.test(mc.receiver))) {
        routeDefs.push({ file, receiver: mc.receiver, method: mc.method.toUpperCase(), url: mc.url, line: mc.line });
      }
    }
  }

  interface MountRule {
    parentFile: string;
    parentReceiver: string;
    prefix: string;
    targetFile: string;
    /** null: the whole module (an imported router). */
    targetReceiver: string | null;
  }
  const rules: MountRule[] = [];
  for (const [file, f] of facts) {
    for (const m of f.mounts) {
      const base = { parentFile: file, parentReceiver: m.receiver, prefix: m.prefix };
      if (m.spec) {
        const r = resolveIn(file, m.spec);
        if (r.kind === 'file') rules.push({ ...base, targetFile: r.path, targetReceiver: null });
      } else if (m.local) {
        const b = bindingOf(file, m.local);
        if (b) rules.push({ ...base, targetFile: b.target, targetReceiver: null });
        else rules.push({ ...base, targetFile: file, targetReceiver: m.local });
      }
    }
  }
  const prefixesFor = (file: string, receiver: string, depth: number): string[] => {
    if (depth > 8) return [''];
    const into = rules.filter(
      (r) => r.targetFile === file && (r.targetReceiver === null || r.targetReceiver === receiver) && !(r.parentFile === file && r.parentReceiver === receiver),
    );
    if (into.length === 0) return [''];
    return into.flatMap((r) => prefixesFor(r.parentFile, r.parentReceiver, depth + 1).map((p) => joinRoute(p, r.prefix)));
  };
  for (const d of routeDefs) {
    for (const prefix of prefixesFor(d.file, d.receiver, 0)) {
      addRoute(joinRoute(prefix, d.url), d.file, d.method === 'ALL' ? [] : [d.method], {
        file: d.file,
        kind: 'server',
        method: d.method === 'ALL' ? '*' : d.method,
        line: d.line,
      });
    }
  }

  const unmatchedCalls: DepGraph['unmatchedCalls'] = [];
  const apiCalls: ApiCall[] = [];
  const patterns = [...routes.keys()];
  for (const c of calls) {
    let best = -1;
    let matches: string[] = [];
    for (const p of patterns) {
      const s = matchRoute(c.url, p);
      if (s > best) {
        best = s;
        matches = [p];
      } else if (s >= 0 && s === best) {
        matches.push(p);
      }
    }
    // A call with no literal path segment (`${base}/${key}`) could be anything, and one that
    // ties between many routes is too ambiguous to link: report both as unmatched.
    const literal = c.url.split('/').some((s) => s !== '' && s !== ':param');
    const unmatched = best < 0 || !literal || matches.length > MAX_AMBIGUOUS_MATCHES;
    if (literal) apiCalls.push({ file: c.file, url: c.url, ...(c.method ? { method: c.method } : {}), line: c.line, routes: unmatched ? [] : [...matches].sort() });
    if (unmatched) {
      unmatchedCalls.push({ file: c.file, url: c.url, line: c.line });
      continue;
    }
    for (const p of matches) edges.add({ from: c.file, to: routeId(p), type: 'calls-api', line: c.line });
  }
  for (const [p, r] of routes) for (const file of r.files) edges.add({ from: routeId(p), to: file, type: 'handles-route' });

  // --- 5. Database tables --------------------------------------------------------------
  const tables = new Map<string, Set<string>>();
  const ensureTable = (name: string) => {
    let t = tables.get(name);
    if (!t) tables.set(name, (t = new Set()));
    return t;
  };
  const defineTable = (name: string, file: string) => {
    ensureTable(name).add(file);
    edges.add({ from: tableId(name), to: file, type: 'defines-table' });
    if (files[file]!.role === 'module') files[file]!.role = 'schema';
  };
  const useTable = (name: string, file: string, line: number) => {
    ensureTable(name);
    edges.add({ from: file, to: tableId(name), type: 'uses-table', line });
  };

  const prismaAccessors = new Map<string, string>();
  const drizzleByName = new Map<string, string>();
  for (const [file, f] of facts) {
    for (const [model, table] of Object.entries(f.prismaModels)) {
      prismaAccessors.set(model[0]!.toLowerCase() + model.slice(1), table);
      defineTable(table, file);
    }
    for (const t of f.ddlTables) defineTable(t, file);
    for (const [local, table] of Object.entries(f.drizzleDefs)) {
      drizzleByName.set(local, table);
      defineTable(table, file);
    }
  }

  const drizzleExport = (file: string, name: string, depth: number): string | null => {
    const f = factsOf(file);
    if (!f || depth > 8) return null;
    const local = f.exportLocals[name] ?? name;
    if (f.drizzleDefs[local]) return f.drizzleDefs[local]!;
    for (const imp of f.imports) {
      if (imp.kind !== 'reexport') continue;
      const star = imp.names[0] === '*' && f.starExports.includes(imp.spec);
      if (!star && !imp.names.includes(name)) continue;
      const r = resolveIn(file, imp.spec);
      if (r.kind !== 'file') continue;
      const found = drizzleExport(r.path, name, depth + 1);
      if (found) return found;
    }
    const b = bindingOf(file, local);
    return b ? drizzleExport(b.target, b.imported, depth + 1) : null;
  };
  const drizzleRef = (file: string, local: string): string | null => {
    const f = factsOf(file)!;
    const dot = local.indexOf('.');
    if (dot > 0) {
      const b = bindingOf(file, local.slice(0, dot));
      return b && b.imported === '*' ? drizzleExport(b.target, local.slice(dot + 1), 0) : null;
    }
    if (f.drizzleDefs[local]) return f.drizzleDefs[local]!;
    const b = bindingOf(file, local);
    return b ? drizzleExport(b.target, b.imported, 0) : null;
  };

  for (const [file, f] of facts) {
    for (const t of f.tables) useTable(t.name, file, t.line);
    for (const pc of f.prismaCalls) {
      const t = prismaAccessors.get(pc.model);
      if (t) useTable(t, file, pc.line);
      else if (prismaAccessors.size === 0 && PRISMA_RECEIVER.test(pc.receiver)) useTable(pc.model.toLowerCase(), file, pc.line);
    }
    for (const ref of f.drizzleRefs) {
      const t = drizzleRef(file, ref.local);
      if (t) useTable(t, file, ref.line);
    }
    for (const q of f.drizzleQueryRefs) {
      const t = drizzleByName.get(q.name);
      if (t) useTable(t, file, q.line);
    }
  }

  // --- 6. Assemble -----------------------------------------------------------------------
  const routeRecord: DepGraph['routes'] = {};
  for (const p of [...routes.keys()].sort()) {
    const r = routes.get(p)!;
    const handlers = [...r.handlers].sort((x, y) => x.file.localeCompare(y.file) || (x.line ?? 0) - (y.line ?? 0));
    routeRecord[p] = { files: [...r.files].sort(), methods: [...r.methods].sort(), handlers };
  }
  const tableRecord: DepGraph['tables'] = {};
  for (const t of [...tables.keys()].sort()) tableRecord[t] = { definedIn: [...tables.get(t)!].sort() };

  return {
    version: 1,
    files,
    routes: routeRecord,
    tables: tableRecord,
    edges: edges.list,
    broken,
    unmatchedCalls,
    apiCalls,
    stats: {
      files: Object.keys(files).length,
      edges: edges.list.length,
      routes: routes.size,
      tables: tables.size,
      broken: broken.length,
      parsed: loaded.parsed,
      cached: loaded.cached,
      ms: Date.now() - started,
    },
  };
}

/**
 * Imports that look missing but point at files that exist outside the listing
 * (ignored or in skipped folders) or at git-ignored paths (generated code that hasn't
 * been built yet) are not reported.
 */
async function dropGenerated<T extends { candidates: string[] }>(root: string, missing: T[]): Promise<T[]> {
  if (missing.length === 0) return [];
  const onDisk = (c: string) => PROBE_EXTS.some((e) => existsSync(path.join(root, c + e)));
  const left = missing.filter((m) => !m.candidates.some(onDisk));
  if (left.length === 0) return [];
  const all = [...new Set(left.flatMap((m) => m.candidates))].filter((c) => c && !c.startsWith('..'));
  const out = all.length ? await gitMaybe(['check-ignore', '-z', '--stdin'], { cwd: root, input: all.join('\0') + '\0' }) : null;
  const ignored = new Set(out ? splitNul(out) : []);
  return left.filter((m) => !m.candidates.some((c) => ignored.has(c)));
}

// --- Queries --------------------------------------------------------------------------

export interface GraphIndex {
  out: Map<string, Edge[]>;
  in: Map<string, Edge[]>;
}

export function indexGraph(g: DepGraph): GraphIndex {
  const out = new Map<string, Edge[]>();
  const inn = new Map<string, Edge[]>();
  for (const e of g.edges) {
    (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e);
    (inn.get(e.to) ?? inn.set(e.to, []).get(e.to)!).push(e);
  }
  return { out, in: inn };
}

export interface Dependent {
  node: string;
  depth: number;
  /** The edge that reached this node (its `to` is the node one step closer to the start). */
  via: Edge;
}

/** Everything that depends on `start`, directly or transitively (reverse BFS), nearest first. */
export function dependentsOf(idx: GraphIndex, start: string, maxDepth = Infinity): Dependent[] {
  const seen = new Set([start]);
  const result: Dependent[] = [];
  let frontier = [start];
  for (let depth = 1; frontier.length > 0 && depth <= maxDepth; depth++) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const e of idx.in.get(node) ?? []) {
        if (seen.has(e.from)) continue;
        seen.add(e.from);
        result.push({ node: e.from, depth, via: e });
        next.push(e.from);
      }
    }
    frontier = next;
  }
  return result;
}

/** Direct dependencies of a node. */
export function dependenciesOf(idx: GraphIndex, node: string): Edge[] {
  return idx.out.get(node) ?? [];
}
