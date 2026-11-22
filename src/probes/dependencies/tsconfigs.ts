import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseJsonc } from './jsonc.js';
import type { WorkspacePackage } from './workspaces.js';

const P = path.posix;

export interface AliasConfig {
  /** The config file (relative to the repo root). */
  file: string;
  /** Directory non-relative imports resolve from (baseUrl), relative to the root, or null. */
  baseUrl: string | null;
  /** `paths` patterns, or null. */
  paths: Record<string, string[]> | null;
  /** Directory `paths` targets are relative to. */
  pathsBase: string;
}

interface RawLevel {
  baseUrl?: string;
  paths?: Record<string, string[]>;
  pathsDir?: string;
  references: string[];
}

const CONFIG_NAMES = ['tsconfig.json', 'jsconfig.json'];

/**
 * Finds the tsconfig/jsconfig that applies to each file: the nearest one walking up from
 * the file's folder to the repo root, like editors do. Follows `extends` (relative files,
 * workspace packages and node_modules) and, when a config has no `paths` but has
 * `references` (Vite's layout), takes them from the referenced configs.
 */
export class TsconfigResolver {
  private nearest = new Map<string, string | null>();
  private loaded = new Map<string, AliasConfig | null>();

  constructor(
    private readonly root: string,
    private readonly all: Set<string>,
    private readonly workspaces: Map<string, WorkspacePackage>,
  ) {}

  forFile(rel: string): AliasConfig | null {
    const configFile = this.nearestConfig(P.dirname(rel) === '.' ? '' : P.dirname(rel));
    return configFile ? this.load(configFile) : null;
  }

  private nearestConfig(dir: string): string | null {
    const memo = this.nearest.get(dir);
    if (memo !== undefined) return memo;
    let found: string | null = null;
    for (const name of CONFIG_NAMES) {
      const f = dir ? `${dir}/${name}` : name;
      if (this.all.has(f)) {
        found = f;
        break;
      }
    }
    if (!found && dir !== '') found = this.nearestConfig(P.dirname(dir) === '.' ? '' : P.dirname(dir));
    this.nearest.set(dir, found);
    return found;
  }

  private load(file: string): AliasConfig | null {
    if (this.loaded.has(file)) return this.loaded.get(file)!;
    this.loaded.set(file, null); // cycle guard
    const leafDir = dirOf(file);
    const eff = this.readLevel(file, leafDir, 0);
    let result: AliasConfig | null = null;
    if (eff) {
      let baseUrl = eff.baseUrl ?? null;
      let paths = eff.paths ?? null;
      let pathsDir = eff.pathsDir ?? leafDir;
      if (!paths && !baseUrl) {
        for (const ref of eff.references) {
          const r = this.load(ref);
          if (r && (r.paths || r.baseUrl)) {
            baseUrl = r.baseUrl;
            paths = r.paths;
            pathsDir = r.pathsBase;
            break;
          }
        }
      }
      result = { file, baseUrl, paths, pathsBase: baseUrl ?? pathsDir };
    }
    this.loaded.set(file, result);
    return result;
  }

  /** Read one config and everything it extends. Paths in the result are root-relative. */
  private readLevel(file: string, leafDir: string, depth: number): RawLevel | null {
    if (depth > 10) return null;
    const json = this.readJson(file) as {
      extends?: string | string[];
      compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
      references?: { path?: string }[];
    } | null;
    if (!json || typeof json !== 'object') return null;
    const dir = dirOf(file);
    const level: RawLevel = { references: [] };
    const exts = json.extends === undefined ? [] : Array.isArray(json.extends) ? json.extends : [json.extends];
    for (const ext of exts) {
      if (typeof ext !== 'string') continue;
      const target = this.resolveExtends(dir, ext);
      const parent = target ? this.readLevel(target, leafDir, depth + 1) : null;
      if (!parent) continue;
      if (parent.baseUrl !== undefined) level.baseUrl = parent.baseUrl;
      if (parent.paths !== undefined) {
        level.paths = parent.paths;
        level.pathsDir = parent.pathsDir;
      }
    }
    const sub = (s: string) => s.replace(/\$\{configDir\}/g, leafDir === '' ? '.' : leafDir);
    const co = json.compilerOptions ?? {};
    if (typeof co.baseUrl === 'string') {
      level.baseUrl = norm(co.baseUrl.includes('${configDir}') ? sub(co.baseUrl) : P.join(dir, co.baseUrl));
    }
    if (co.paths && typeof co.paths === 'object') {
      const paths: Record<string, string[]> = {};
      let usesConfigDir = false;
      for (const [k, v] of Object.entries(co.paths)) {
        if (!Array.isArray(v)) continue;
        paths[k] = v.filter((x): x is string => typeof x === 'string').map((x) => {
          if (x.includes('${configDir}')) usesConfigDir = true;
          return sub(x);
        });
      }
      level.paths = paths;
      level.pathsDir = usesConfigDir ? '' : dir;
    }
    if (Array.isArray(json.references)) {
      for (const r of json.references) {
        if (typeof r?.path !== 'string') continue;
        const p = norm(P.join(dir, r.path));
        level.references.push(p.endsWith('.json') ? p : P.join(p, 'tsconfig.json'));
      }
    }
    return level;
  }

  private resolveExtends(dir: string, spec: string): string | null {
    const candidates: string[] = [];
    if (spec.startsWith('.') || spec.startsWith('/')) {
      const base = norm(P.join(dir, spec));
      candidates.push(base, `${base}.json`, P.join(base, 'tsconfig.json'));
    } else {
      // Workspace package, then node_modules (if installed).
      for (const [name, ws] of this.workspaces) {
        if (spec === name || spec.startsWith(name + '/')) {
          const rest = spec.slice(name.length + 1);
          const base = rest ? P.join(ws.dir, rest) : P.join(ws.dir, 'tsconfig.json');
          candidates.push(base, `${base}.json`);
        }
      }
      for (let d = dir; ; d = dirOf(d)) {
        const base = P.join(d, 'node_modules', spec);
        candidates.push(base, `${base}.json`, P.join(base, 'tsconfig.json'));
        if (d === '') break;
      }
    }
    for (const c of candidates) {
      if (this.all.has(c) || (c.endsWith('.json') && existsSync(path.join(this.root, c)))) return c;
    }
    return null;
  }

  private readJson(file: string): unknown {
    try {
      return parseJsonc(readFileSync(path.join(this.root, file), 'utf8'));
    } catch {
      return null;
    }
  }
}

function dirOf(file: string): string {
  const d = P.dirname(file);
  return d === '.' ? '' : d;
}

function norm(p: string): string {
  const n = P.normalize(p).replace(/\/+$/, '');
  return n === '.' ? '' : n;
}
