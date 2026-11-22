import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface PackageJson {
  name?: string;
  workspaces?: string[] | { packages?: string[] };
  exports?: unknown;
  main?: string;
  module?: string;
  types?: string;
  typings?: string;
  source?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** Every package.json in the listing, keyed by its directory ('' for the repo root). */
export async function loadPackageJsons(root: string, all: Set<string>): Promise<Map<string, PackageJson>> {
  const out = new Map<string, PackageJson>();
  const files = [...all].filter((p) => p === 'package.json' || p.endsWith('/package.json'));
  await Promise.all(
    files.map(async (p) => {
      try {
        const pkg = JSON.parse(await readFile(path.join(root, p), 'utf8')) as PackageJson;
        if (pkg && typeof pkg === 'object') out.set(path.posix.dirname(p) === '.' ? '' : path.posix.dirname(p), pkg);
      } catch {
        /* invalid package.json: ignore */
      }
    }),
  );
  return out;
}

/** The `packages:` list of a pnpm-workspace.yaml (block or flow style). */
export function parsePnpmWorkspace(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  const unquote = (s: string) => s.trim().replace(/^['"]|['"]$/g, '');
  for (let i = 0; i < lines.length; i++) {
    const m = /^packages\s*:\s*(.*)$/.exec(lines[i]!);
    if (!m) continue;
    const inline = m[1]!.replace(/#.*$/, '').trim();
    if (inline.startsWith('[')) {
      return inline
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map(unquote)
        .filter(Boolean);
    }
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]!.replace(/#.*$/, '');
      if (line.trim() === '') continue;
      const item = /^\s+-\s*(.+)$/.exec(line);
      if (!item) break;
      out.push(unquote(item[1]!));
    }
    break;
  }
  return out;
}

export function globToRegExp(glob: string): RegExp {
  const g = glob.replace(/^\.\//, '').replace(/\/+$/, '');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === '*' && g[i + 1] === '*') {
      re += '.*';
      i++;
      if (g[i + 1] === '/') i++;
    } else if (c === '*') {
      re += '[^/]*';
    } else {
      re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

export interface WorkspacePackage {
  name: string;
  dir: string;
  pkg: PackageJson;
}

/**
 * Workspace packages declared by npm/yarn (`workspaces` in the root package.json) or
 * pnpm (pnpm-workspace.yaml), keyed by package name.
 */
export function workspacePackages(
  packages: Map<string, PackageJson>,
  pnpmWorkspaceYaml: string | null,
): Map<string, WorkspacePackage> {
  const rootPkg = packages.get('');
  const declared = rootPkg?.workspaces;
  const patterns = [
    ...(Array.isArray(declared) ? declared : (declared?.packages ?? [])),
    ...(pnpmWorkspaceYaml ? parsePnpmWorkspace(pnpmWorkspaceYaml) : []),
  ].filter((p): p is string => typeof p === 'string');
  const include = patterns.filter((p) => !p.startsWith('!')).map(globToRegExp);
  const exclude = patterns.filter((p) => p.startsWith('!')).map((p) => globToRegExp(p.slice(1)));
  const out = new Map<string, WorkspacePackage>();
  if (include.length === 0) return out;
  for (const [dir, pkg] of packages) {
    if (dir === '' || !pkg.name) continue;
    if (include.some((r) => r.test(dir)) && !exclude.some((r) => r.test(dir))) {
      out.set(pkg.name, { name: pkg.name, dir, pkg });
    }
  }
  return out;
}
