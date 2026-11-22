import path from 'node:path';
import type { FileKind } from './files.js';
import type { TsconfigResolver } from './tsconfigs.js';
import type { WorkspacePackage } from './workspaces.js';

const P = path.posix;

export type Resolution =
  /** A file in the graph. */
  | { kind: 'file'; path: string }
  /** Exists, but is not analysed (CSS, JSON, .d.ts, images…). */
  | { kind: 'asset' }
  /** A package or anything else outside the project. */
  | { kind: 'external' }
  /** Should be a project file but none was found. `candidates` are the paths tried. */
  | { kind: 'missing'; candidates: string[] };

const TRY_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const DECL_EXTS = ['.d.ts', '.d.mts', '.d.cts'];
const JS_TO_TS: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};
const BUILD_DIRS = new Set(['dist', 'build', 'lib', 'out', 'esm', 'cjs', 'es', 'types', 'umd']);
const CONDITION_ORDER = ['source', 'types', 'typings', 'import', 'module', 'browser', 'react-server', 'node', 'default', 'require'];

export class Resolver {
  private tried = new Map<string, Resolution | null>();
  private wsNames: string[];
  private memo = new Map<string, Resolution>();

  constructor(
    private readonly all: Set<string>,
    /** Files that are graph nodes. */
    private readonly analysed: Map<string, FileKind>,
    private readonly tsconfigs: TsconfigResolver,
    private readonly workspaces: Map<string, WorkspacePackage>,
  ) {
    this.wsNames = [...workspaces.keys()].sort((a, b) => b.length - a.length);
  }

  resolve(from: string, rawSpec: string): Resolution {
    const fromDir = dirOf(from);
    const spec = rawSpec.replace(/[?#].*$/, '');
    const relative = spec === '.' || spec === '..' || spec.startsWith('./') || spec.startsWith('../');
    // Relative specs depend only on the importer's folder; others on its config too.
    const key = relative ? `${fromDir}\0${spec}` : `${this.tsconfigs.forFile(from)?.file ?? ''}\0${spec}`;
    const hit = this.memo.get(key);
    if (hit) return hit;
    const r = this.resolveUncached(fromDir, from, spec, relative);
    this.memo.set(key, r);
    return r;
  }

  private resolveUncached(fromDir: string, from: string, spec: string, relative: boolean): Resolution {
    if (!spec) return { kind: 'external' };
    if (relative) {
      const base = norm(P.join(fromDir, spec));
      return this.tryPath(base) ?? { kind: 'missing', candidates: [base] };
    }
    if (spec.startsWith('/')) {
      // Vite-style root-relative or public/ asset. Never reported as missing.
      return this.tryPath(norm(spec.slice(1))) ?? this.tryPath(norm('public' + spec)) ?? { kind: 'external' };
    }

    const config = this.tsconfigs.forFile(from);
    if (config?.paths) {
      const match = matchPaths(config.paths, spec);
      if (match) {
        const candidates = match.targets.map((t) => norm(P.join(config.pathsBase, t)));
        for (const c of candidates) {
          const r = this.tryPath(c);
          if (r) return r;
        }
        const ws = this.resolveWorkspace(spec);
        if (ws) return ws;
        // A catch-all "*" pattern matches packages too; don't call those missing.
        if (match.key !== '*') return { kind: 'missing', candidates };
      }
    }
    if (config?.baseUrl !== null && config?.baseUrl !== undefined) {
      const r = this.tryPath(norm(P.join(config.baseUrl, spec)));
      if (r) return r;
    }
    return this.resolveWorkspace(spec) ?? { kind: 'external' };
  }

  /** Workspace package imports (`@acme/ui`, `@acme/ui/button`) → their source files. */
  private resolveWorkspace(spec: string): Resolution | null {
    const name = this.wsNames.find((n) => spec === n || spec.startsWith(n + '/'));
    if (!name) return null;
    const ws = this.workspaces.get(name)!;
    const sub = spec === name ? '.' : './' + spec.slice(name.length + 1);
    const cands: string[] = [];
    const exp = ws.pkg.exports;
    if (exp !== undefined && exp !== null) {
      const map: Record<string, unknown> =
        typeof exp === 'object' && !Array.isArray(exp) && Object.keys(exp).some((k) => k.startsWith('.'))
          ? (exp as Record<string, unknown>)
          : { '.': exp };
      if (sub in map) {
        cands.push(...leaves(map[sub]));
      } else {
        // Subpath patterns: "./*": "./src/*.tsx"
        for (const [k, v] of Object.entries(map)) {
          const star = k.indexOf('*');
          if (star < 0) continue;
          const pre = k.slice(0, star);
          const post = k.slice(star + 1);
          if (sub.startsWith(pre) && sub.endsWith(post) && sub.length >= pre.length + post.length) {
            const mid = sub.slice(pre.length, sub.length - post.length);
            cands.push(...leaves(v).map((l) => l.split('*').join(mid)));
          }
        }
      }
    }
    if (sub === '.') {
      for (const f of [ws.pkg.source, ws.pkg.types, ws.pkg.typings, ws.pkg.module, ws.pkg.main]) {
        if (typeof f === 'string') cands.push(f);
      }
      cands.push('index', 'src/index');
    } else {
      cands.push(sub, 'src/' + sub.slice(2));
    }

    let asset: Resolution | null = null;
    const tried: string[] = [];
    for (const c of cands) {
      const relInPkg = norm(c);
      for (const p of [relInPkg, ...distToSrc(relInPkg)]) {
        const full = norm(P.join(ws.dir, p));
        tried.push(full);
        const r = this.tryPath(full);
        if (r?.kind === 'file') return r;
        if (r && !asset) asset = r;
      }
    }
    if (asset) return asset;
    // Only call it missing when the package has source we could have resolved into;
    // packages that only ship build output (not committed) are treated as external.
    const prefix = ws.dir + '/';
    for (const f of this.analysed.keys()) if (f.startsWith(prefix)) return { kind: 'missing', candidates: tried };
    return { kind: 'external' };
  }

  /** Try a path as a file, with extension swaps, added extensions and index files. */
  tryPath(base: string): Resolution | null {
    if (this.tried.has(base)) return this.tried.get(base)!;
    const r = this.tryPathUncached(base);
    this.tried.set(base, r);
    return r;
  }

  private tryPathUncached(base: string): Resolution | null {
    const asFile = (p: string): Resolution | null => {
      if (this.analysed.get(p) === 'source') return { kind: 'file', path: p };
      if (this.all.has(p)) return { kind: 'asset' };
      return null;
    };
    const direct = asFile(base);
    if (direct) return direct;
    const ext = P.extname(base);
    const swaps = JS_TO_TS[ext];
    if (swaps) {
      const stem = base.slice(0, -ext.length);
      for (const s of swaps) {
        const r = asFile(stem + s);
        if (r) return r;
      }
    }
    for (const e of [...TRY_EXTS, ...DECL_EXTS]) {
      const r = asFile(base + e);
      if (r) return r;
    }
    for (const e of [...TRY_EXTS, ...DECL_EXTS]) {
      const r = asFile(`${base === '' ? '' : base + '/'}index${e}`);
      if (r) return r;
    }
    return null;
  }
}

/** TypeScript `paths` matching: exact keys win, then the longest prefix before '*'. */
export function matchPaths(paths: Record<string, string[]>, spec: string): { key: string; targets: string[] } | null {
  if (paths[spec]) return { key: spec, targets: paths[spec]! };
  let best: { key: string; targets: string[]; len: number } | null = null;
  for (const [key, targets] of Object.entries(paths)) {
    const star = key.indexOf('*');
    if (star < 0) continue;
    const pre = key.slice(0, star);
    const post = key.slice(star + 1);
    if (spec.length >= pre.length + post.length && spec.startsWith(pre) && spec.endsWith(post)) {
      if (!best || pre.length > best.len) {
        const mid = spec.slice(pre.length, spec.length - post.length);
        best = { key, targets: targets.map((t) => t.replace('*', mid)), len: pre.length };
      }
    }
  }
  return best ? { key: best.key, targets: best.targets } : null;
}

/** Leaf strings of an `exports` entry, most source-like conditions first. */
function leaves(entry: unknown): string[] {
  if (typeof entry === 'string') return [entry];
  if (Array.isArray(entry)) return entry.flatMap(leaves);
  if (entry && typeof entry === 'object') {
    const obj = entry as Record<string, unknown>;
    const keys = Object.keys(obj).sort((a, b) => rank(a) - rank(b));
    return keys.flatMap((k) => leaves(obj[k]));
  }
  return [];
}

const rank = (k: string) => {
  const i = CONDITION_ORDER.indexOf(k);
  return i < 0 ? CONDITION_ORDER.length : i;
};

/** Map a build-output path back to likely source paths: dist/esm/button.js → src/button, button. */
export function distToSrc(relInPkg: string): string[] {
  const segs = relInPkg.split('/');
  let i = 0;
  while (i < segs.length - 1 && BUILD_DIRS.has(segs[i]!)) i++;
  if (i === 0) return [];
  const rest = segs
    .slice(i)
    .join('/')
    .replace(/\.d\.(ts|mts|cts)$/, '')
    .replace(/\.(js|mjs|cjs|jsx)$/, '');
  return [`src/${rest}`, rest];
}

function dirOf(file: string): string {
  const d = P.dirname(file);
  return d === '.' ? '' : d;
}

function norm(p: string): string {
  const n = P.normalize(p).replace(/\/+$/, '');
  return n === '.' ? '' : n;
}
