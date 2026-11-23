import type { Dependent } from './graph.js';
import type { BrokenImport, DepGraph, Edge } from './types.js';
import { agree, plural } from '../../plural.js';

export type NodeCategory = 'page' | 'route' | 'table' | 'file';

export function categoryOf(g: DepGraph, node: string): NodeCategory {
  if (node.startsWith('route:')) return 'route';
  if (node.startsWith('table:')) return 'table';
  return g.files[node]?.role === 'page' ? 'page' : 'file';
}

/** "route /api/users", "table users", "page app/users/page.tsx", "app/lib/db.ts". */
export function nodeLabel(g: DepGraph, node: string): string {
  if (node.startsWith('route:')) {
    const pattern = node.slice(6);
    const methods = g.routes[pattern]?.methods ?? [];
    return `route ${methods.length > 0 && methods.length < 4 ? methods.join('|') + ' ' : ''}${pattern}`;
  }
  if (node.startsWith('table:')) return `table ${node.slice(6)}`;
  const role = g.files[node]?.role;
  if (role === 'page') return `page ${node}`;
  if (role === 'server-action') return `${node} (server actions)`;
  return node;
}

const short = (node: string) => (node.startsWith('route:') ? node.slice(6) : node.startsWith('table:') ? node.slice(6) : node);

/** How `edge.from` depends on `edge.to`, phrased from the dependent's side. */
export function relation(e: Edge): string {
  switch (e.type) {
    case 'import':
      return `imports ${short(e.to)}`;
    case 'server-action':
      return `calls server actions in ${short(e.to)}`;
    case 'calls-api':
      return `calls ${short(e.to)}`;
    case 'handles-route':
      return `handled by ${short(e.to)}`;
    case 'uses-table':
      return `uses table ${short(e.to)}`;
    case 'defines-table':
      return `defined in ${short(e.to)}`;
  }
}

const ORDER: NodeCategory[] = ['page', 'route', 'table', 'file'];
const NOUN: Record<NodeCategory, string> = { page: 'page', route: 'API route', table: 'table', file: 'file' };

/** "2 API routes, 3 pages, 4 files" */
export function summarizeDependents(g: DepGraph, deps: Dependent[]): string {
  const counts = new Map<NodeCategory, number>();
  for (const d of deps) {
    const c = categoryOf(g, d.node);
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return ORDER.filter((c) => counts.get(c))
    .map((c) => plural(counts.get(c)!, NOUN[c]))
    .join(', ');
}

/** "lib/db.ts (modified) → 1 page depends on it", "… → 2 pages, 1 file depend on it": the verb agrees with the total. */
export function dependentsTitle(g: DepGraph, changedPath: string, status: string, deps: Dependent[]): string {
  return `${changedPath} (${status}) → ${summarizeDependents(g, deps)} ${agree(deps.length, 'depends', 'depend')} on it`;
}

/** One line per dependent: direct ones first, then by category. */
export function describeDependents(g: DepGraph, deps: Dependent[], cap = 12): string[] {
  const sorted = [...deps].sort(
    (a, b) =>
      Math.min(a.depth, 2) - Math.min(b.depth, 2) ||
      ORDER.indexOf(categoryOf(g, a.node)) - ORDER.indexOf(categoryOf(g, b.node)) ||
      a.depth - b.depth ||
      a.node.localeCompare(b.node),
  );
  const lines = sorted.slice(0, cap).map((d) => `${nodeLabel(g, d.node)}  (${d.depth === 1 ? 'directly: ' : ''}${relation(d.via)})`);
  if (sorted.length > cap) lines.push(`…and ${sorted.length - cap} more`);
  return lines;
}

export function brokenTitle(b: BrokenImport): string {
  return b.reason === 'missing-file'
    ? `${b.file}:${b.line} imports "${b.spec}", which doesn't exist`
    : `${b.file}:${b.line} imports ${b.name === 'default' ? 'the default export' : `{ ${b.name} }`} from "${b.spec}", which ${b.target ?? 'it'} doesn't export`;
}

export const brokenKey = (b: BrokenImport) => `${b.file}\0${b.spec}\0${b.reason}\0${b.name ?? ''}`;
