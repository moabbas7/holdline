/**
 * Static analysis of every API route found by the dependency graph: one TypeScript program
 * per tsconfig (only route files as roots, imports resolved on demand), cached per route
 * by the content hash of everything the route file imports.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ts as TsNs } from 'ts-morph';
import { HOLDLINE_DIR } from '../../core/store.js';
import { git, splitNul } from '../../core/git.js';
import { decodeText } from '../dependencies/files.js';
import { exists, writeCompactJson } from '../dependencies/store.js';
import type { DepGraph, RouteHandler } from '../dependencies/types.js';
import { HandlerAnalyser, type HandlerResult } from './handler.js';
import { union } from './shape.js';
import { API_ANALYSER_VERSION, type ApiStats, type MethodApi, type RouteApi } from './types.js';

const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock'];
const CONFIG_NAMES = ['tsconfig.json', 'jsconfig.json'];

export interface AnalyseOptions {
  timeoutMs: number;
  /** Override for tests. */
  analyserVersion?: number;
}

export interface AnalyseResult {
  routes: Record<string, RouteApi>;
  stats: ApiStats;
  warnings: string[];
}

interface CacheFile {
  version: number;
  entries: Record<string, HandlerResult>;
}

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
export const apiCachePath = (root: string) => path.join(root, HOLDLINE_DIR, 'cache', 'api-v1.json');

/** Route params from a pattern: `/users/:id/*` → ['id', '*']. */
export function paramsOf(pattern: string): string[] {
  return pattern
    .split('/')
    .filter((s) => s.startsWith(':') || s === '*' || s === '*?')
    .map((s) => (s.startsWith(':') ? s.slice(1) : '*'));
}

function handlersOf(graph: DepGraph, pattern: string): RouteHandler[] {
  const r = graph.routes[pattern]!;
  if (r.handlers?.length) return r.handlers;
  return r.files.map((file) => ({ file, kind: /(^|\/)pages\/api\//.test(file) ? 'next-pages' : 'next-app' }) as RouteHandler);
}

const handlerId = (h: RouteHandler) => `${h.kind}:${h.file}:${h.method ?? ''}:${h.line ?? ''}`;

export async function analyseApi(root: string, graph: DepGraph, opts: AnalyseOptions): Promise<AnalyseResult> {
  const started = Date.now();
  const patterns = Object.keys(graph.routes).sort();
  const warnings: string[] = [];
  const stats: ApiStats = { routes: patterns.length, analysed: 0, unknown: 0, cached: 0, mode: 'none', ms: 0 };
  if (patterns.length === 0) return { routes: {}, stats: { ...stats, ms: Date.now() - started }, warnings };

  // Global inputs that affect types: declaration files, tsconfigs, lockfiles.
  const typeInputs = await typeInputFiles(root);
  const dts = typeInputs.filter((p) => /\.d\.[cm]?ts$/.test(p));
  const configs = new Set(typeInputs.filter((p) => CONFIG_NAMES.includes(path.posix.basename(p))));
  const globalParts: string[] = [String(opts.analyserVersion ?? API_ANALYSER_VERSION)];
  for (const f of typeInputs) {
    try {
      globalParts.push(`${f}:${sha(await readFile(path.join(root, f))).slice(0, 16)}`);
    } catch {
      /* unreadable */
    }
  }
  globalParts.push(...installState(root, [...configs].map((c) => path.posix.dirname(c))));
  const globalHash = sha(globalParts.join('\n'));

  // Import closure of each handler file (for cache keys).
  const out = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (e.type !== 'import' && e.type !== 'server-action') continue;
    (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e.to);
  }
  const closureMemo = new Map<string, string>();
  const closureHash = (file: string): string => {
    const memo = closureMemo.get(file);
    if (memo) return memo;
    const seen = new Set([file]);
    const queue = [file];
    while (queue.length && seen.size < 20_000) {
      for (const n of out.get(queue.shift()!) ?? []) {
        if (!seen.has(n)) {
          seen.add(n);
          queue.push(n);
        }
      }
    }
    const h = sha(globalHash + [...seen].sort().map((f) => `${f}:${graph.files[f]?.hash ?? ''}`).join('\n'));
    closureMemo.set(file, h);
    return h;
  };

  const cacheFile = apiCachePath(root);
  let cache: CacheFile = { version: API_ANALYSER_VERSION, entries: {} };
  try {
    const parsed = JSON.parse(await readFile(cacheFile, 'utf8')) as CacheFile;
    if (parsed?.version === API_ANALYSER_VERSION && parsed.entries) cache = parsed;
  } catch {
    /* none yet */
  }
  const used: Record<string, HandlerResult> = {};

  interface Job {
    pattern: string;
    handler: RouteHandler;
    key: string;
  }
  const results = new Map<Job, HandlerResult>();
  const jobs: Job[] = [];
  for (const p of patterns) {
    for (const h of handlersOf(graph, p)) {
      const key = `${handlerId(h)}|${p}|${closureHash(h.file)}`;
      jobs.push({ pattern: p, handler: h, key });
    }
  }
  const misses: Job[] = [];
  for (const j of jobs) {
    const hit = cache.entries[j.key];
    if (hit) {
      results.set(j, hit);
      used[j.key] = hit;
      stats.cached++;
    } else misses.push(j);
  }

  if (misses.length > 0) {
    const tsm = await import('ts-morph');
    const groups = new Map<string, Job[]>();
    for (const j of misses) {
      const cfg = nearestConfig(root, j.handler.file, configs);
      (groups.get(cfg) ?? groups.set(cfg, []).get(cfg)!).push(j);
    }
    const modes = new Set<'typed' | 'syntax'>();
    const deadline = started + opts.timeoutMs;
    for (const [cfg, group] of groups) {
      const files = [...new Set(group.map((j) => j.handler.file))];
      const scope = cfg ? path.posix.dirname(cfg) : '';
      const ambient = dts.filter((d) => scope === '' || scope === '.' || d.startsWith(scope + '/'));
      let program: { checker: TsNs.TypeChecker; sourceFile: (rel: string) => TsNs.SourceFile | undefined } | null = null;
      try {
        program = typedProgram(tsm, root, cfg, files, ambient);
        modes.add('typed');
      } catch (e) {
        warnings.push(`TypeScript project ${cfg || '(default)'} could not be loaded (${(e as Error).message.split('\n')[0]}); response shapes come from object literals only`);
      }
      for (const j of group) {
        if (Date.now() > deadline) {
          results.set(j, { methods: {}, unknown: `analysis time budget (${Math.round(opts.timeoutMs / 1000)}s) exceeded` });
          continue;
        }
        let res: HandlerResult;
        try {
          let sf = program?.sourceFile(j.handler.file);
          let checker = program?.checker;
          if (!sf || !checker) {
            const s = syntaxProgram(tsm, root, j.handler.file);
            sf = s.sf;
            checker = s.checker;
            modes.add('syntax');
          }
          const analyser = new HandlerAnalyser(tsm.ts, checker, (f) => relPath(root, f.fileName));
          res = analyser.analyse(sf, j.handler, paramsOf(j.pattern));
          used[j.key] = res;
        } catch (e) {
          res = { methods: {}, unknown: `analysis failed: ${(e as Error).message.split('\n')[0]!.slice(0, 200)}` };
        }
        results.set(j, res);
      }
    }
    stats.mode = modes.size === 2 ? 'mixed' : modes.has('typed') ? 'typed' : modes.has('syntax') ? 'syntax' : 'none';
  } else stats.mode = 'typed';

  if (await exists(path.join(root, HOLDLINE_DIR))) {
    const changed = misses.length > 0 || Object.keys(cache.entries).some((k) => !(k in used));
    if (changed) await writeCompactJson(cacheFile, { version: API_ANALYSER_VERSION, entries: used } satisfies CacheFile);
  }

  const routes: Record<string, RouteApi> = {};
  for (const p of patterns) {
    const mine = jobs.filter((j) => j.pattern === p);
    const route: RouteApi = { pattern: p, files: graph.routes[p]!.files, methods: {} };
    const reasons: string[] = [];
    for (const j of mine) {
      const r = results.get(j)!;
      if (r.unknown) reasons.push(r.unknown);
      for (const [m, api] of Object.entries(r.methods)) route.methods[m] = route.methods[m] ? mergeMethod(route.methods[m]!, api) : api;
    }
    if (Object.keys(route.methods).length === 0) {
      route.unknown = reasons[0] ?? 'no handlers found';
      stats.unknown++;
    } else stats.analysed++;
    routes[p] = route;
  }
  stats.ms = Date.now() - started;
  return { routes, stats, warnings };
}

function mergeMethod(a: MethodApi, b: MethodApi): MethodApi {
  const by = new Map(a.responses.map((r) => [String(r.status), { ...r }]));
  for (const r of b.responses) {
    const cur = by.get(String(r.status));
    if (!cur) by.set(String(r.status), { ...r });
    else {
      cur.body = cur.body && r.body ? union([cur.body, r.body]) : (cur.body ?? r.body);
      cur.at = [...new Set([...cur.at, ...r.at])].slice(0, 3);
    }
  }
  return {
    responses: [...by.values()],
    complete: a.complete && b.complete,
    ...(a.throws || b.throws ? { throws: true as const } : {}),
    request: { ...a.request, query: [...new Set([...a.request.query, ...b.request.query])].sort() },
  };
}

/**
 * Files outside the import graph that still change types: declaration files, tsconfigs and
 * lockfiles (tracked or untracked, not ignored; dependency folders skipped).
 */
async function typeInputFiles(root: string): Promise<string[]> {
  const specs = ['*.d.ts', '*.d.mts', '*.d.cts', ...CONFIG_NAMES.map((n) => `*${n}`), ...LOCKFILES];
  const out = await git(['ls-files', '-z', '-co', '--exclude-standard', '--', ...specs.map((s) => `:(glob)**/${s}`)], { cwd: root });
  return splitNul(out)
    .filter((p) => !/(^|\/)(node_modules|\.next|dist|build|\.holdline)\//.test(p))
    .filter((p) => !CONFIG_NAMES.some((n) => p.endsWith(n)) || CONFIG_NAMES.includes(path.posix.basename(p)))
    .filter((p) => !LOCKFILES.some((l) => p.endsWith(l)) || LOCKFILES.includes(path.posix.basename(p)))
    .sort();
}

const INSTALL_MARKERS = ['node_modules/.modules.yaml', 'node_modules/.package-lock.json', 'node_modules/.yarn-state.yml', 'node_modules/.yarn-integrity', 'node_modules/.prisma/client/index.d.ts'];

/**
 * node_modules is git-ignored, but installing or regenerating it (prisma generate) changes
 * types: fingerprint its install markers at the root and next to each tsconfig.
 */
function installState(root: string, dirs: string[]): string[] {
  const out: string[] = [];
  for (const dir of new Set(['.', ...dirs])) {
    for (const m of INSTALL_MARKERS) {
      const rel = dir === '.' ? m : `${dir}/${m}`;
      try {
        const st = statSync(path.join(root, rel));
        out.push(`${rel}@${st.size}:${Math.round(st.mtimeMs)}`);
      } catch {
        /* absent */
      }
    }
  }
  return out;
}

const relPath = (root: string, abs: string) => {
  const r = path.relative(root, abs).split(path.sep).join('/');
  return r.startsWith('..') ? abs : r;
};

/** Nearest tsconfig.json/jsconfig.json walking up from the file ('' when none). */
function nearestConfig(root: string, file: string, all: Set<string>): string {
  let dir = path.posix.dirname(file);
  for (;;) {
    for (const n of CONFIG_NAMES) {
      const c = dir === '.' ? n : `${dir}/${n}`;
      if (all.has(c) || existsSync(path.join(root, c))) return c;
    }
    if (dir === '.' || dir === '') return '';
    dir = path.posix.dirname(dir);
  }
}

type TsMorph = typeof import('ts-morph');

function typedProgram(tsm: TsMorph, root: string, cfg: string, files: string[], ambient: string[]) {
  const { Project, ts } = tsm;
  const overrides = {
    noEmit: true,
    skipLibCheck: true,
    allowJs: true,
    strictNullChecks: true,
    // Path-mapped and bundler-style imports resolve as in the editor.
    resolveJsonModule: true,
  };
  let project;
  if (cfg) {
    project = new Project({ tsConfigFilePath: path.join(root, cfg), skipAddingFilesFromTsConfig: true, compilerOptions: overrides });
  } else {
    project = new Project({
      compilerOptions: {
        ...overrides,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        jsx: ts.JsxEmit.Preserve,
        esModuleInterop: true,
      },
    });
  }
  for (const f of [...ambient, ...files]) project.addSourceFileAtPathIfExists(path.join(root, f));
  const program = project.getProgram().compilerObject;
  const checker = program.getTypeChecker();
  return {
    checker,
    sourceFile: (rel: string) => program.getSourceFile(path.join(root, rel).split(path.sep).join('/')) ?? program.getSourceFile(path.join(root, rel)),
  };
}

/** A program with just this file (imports unresolved): object literals and local types only. */
function syntaxProgram(tsm: TsMorph, root: string, rel: string) {
  const { Project, ts } = tsm;
  const project = new Project({
    useInMemoryFileSystem: true,
    skipFileDependencyResolution: true,
    compilerOptions: { allowJs: true, strictNullChecks: true, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.Preserve, noEmit: true },
  });
  const text = decodeText(readFileSync(path.join(root, rel)));
  project.createSourceFile(path.posix.join(root.split(path.sep).join('/'), rel), text);
  const program = project.getProgram().compilerObject;
  const sf = program.getSourceFile(path.posix.join(root.split(path.sep).join('/'), rel))!;
  return { sf, checker: program.getTypeChecker() };
}
