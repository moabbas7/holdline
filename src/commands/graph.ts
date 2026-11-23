import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, type ProjectType } from '../core/config.js';
import { detectProjectType } from '../core/detect.js';
import { HoldlineError } from '../core/errors.js';
import type { Io } from '../io.js';
import { categoryOf, nodeLabel, relation, summarizeDependents, brokenTitle } from '../probes/dependencies/format.js';
import { buildGraph, dependenciesOf, dependentsOf, indexGraph, type Dependent } from '../probes/dependencies/graph.js';
import { matchRoute } from '../probes/dependencies/routes.js';
import type { BrokenImport, DepGraph, Edge, GraphStats } from '../probes/dependencies/types.js';
import { openProject } from './common.js';
import { plural } from '../plural.js';

export interface GraphOptions {
  json?: boolean;
}

export interface GraphResult {
  target: string;
  node: string;
  role: string;
  dependsOn: Edge[];
  dependents: Dependent[];
  broken: BrokenImport[];
  stats: GraphStats;
}

const LIST_CAP = 40;

async function projectTypeFor(root: string): Promise<ProjectType> {
  try {
    return (await loadConfig(root)).projectType;
  } catch {
    try {
      return detectProjectType(JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')));
    } catch {
      return 'unknown';
    }
  }
}

/** Find the graph node for a user-supplied target: a file path, `route:/path` or `table:name`. */
function findNode(g: DepGraph, root: string, cwd: string, target: string): string {
  if (target.startsWith('route:')) {
    const want = '/' + target.slice(6).split(/[?#]/)[0]!.split('/').filter(Boolean).join('/');
    if (g.routes[want]) return `route:${want}`;
    let best = -1;
    let found: string | null = null;
    for (const p of Object.keys(g.routes)) {
      const s = matchRoute(want, p);
      if (s > best) [best, found] = [s, p];
    }
    if (found) return `route:${found}`;
    throw new HoldlineError(`No API route matches ${want}. Known routes: ${Object.keys(g.routes).join(', ') || '(none)'}`);
  }
  if (target.startsWith('table:')) {
    const name = target.slice(6).toLowerCase();
    if (g.tables[name]) return `table:${name}`;
    throw new HoldlineError(`No table named ${name} found. Known tables: ${Object.keys(g.tables).join(', ') || '(none)'}`);
  }
  const rel = path.relative(root, path.resolve(cwd, target)).split(path.sep).join('/');
  if (g.files[rel]) return rel;
  throw new HoldlineError(
    `${rel} is not in the dependency graph. Only source files (.ts, .tsx, .js, …), .sql and .prisma files ` +
      'that git tracks or sees as untracked (not ignored) are analysed; node_modules and build output are skipped.',
  );
}

export async function graphCommand(cwd: string, target: string, opts: GraphOptions, io: Io): Promise<GraphResult> {
  const { root } = await openProject(cwd);
  const graph = await buildGraph(root, { projectType: await projectTypeFor(root) });
  const node = findNode(graph, root, cwd, target);
  const idx = indexGraph(graph);
  const dependsOn = dependenciesOf(idx, node);
  const dependents = dependentsOf(idx, node);
  const broken = graph.broken.filter((b) => b.file === node || b.target === node);
  const role = node.startsWith('route:') ? 'API route' : node.startsWith('table:') ? 'table' : graph.files[node]!.role;
  const result: GraphResult = { target, node, role, dependsOn, dependents, broken, stats: graph.stats };
  if (!opts.json) printGraph(graph, result, io);
  return result;
}

function printGraph(g: DepGraph, r: GraphResult, io: Io): void {
  const cap = (lines: string[]) =>
    lines.length > LIST_CAP ? [...lines.slice(0, LIST_CAP), io.c.dim(`…and ${lines.length - LIST_CAP} more (use --json for the full list)`)] : lines;

  io.log(`${io.c.bold(nodeLabel(g, r.node))}  ${io.c.dim(`(${r.role})`)}`);
  const routesHandled = g.edges.filter((e) => e.type === 'handles-route' && e.to === r.node).map((e) => e.from.slice(6));
  if (routesHandled.length > 0) io.log(`Handles: ${routesHandled.map((p) => io.c.cyan(p)).join(', ')}`);

  io.log();
  io.log(io.c.bold(`Depends on (${r.dependsOn.length}):`));
  if (r.dependsOn.length === 0) io.log(io.c.dim('  nothing in this project'));
  for (const line of cap(r.dependsOn.map((e) => relation(e)).sort())) io.log(`  ${line}`);

  io.log();
  const summary = r.dependents.length > 0 ? `: ${summarizeDependents(g, r.dependents)}` : '';
  io.log(io.c.bold(`Depended on by (${r.dependents.length})${summary}`));
  if (r.dependents.length === 0) io.log(io.c.dim('  nothing: changing it should not affect other files'));
  const direct = r.dependents.filter((d) => d.depth === 1);
  const indirect = r.dependents.filter((d) => d.depth > 1);
  const order = ['page', 'route', 'table', 'file'];
  const sortDeps = (ds: Dependent[]) =>
    [...ds].sort((a, b) => order.indexOf(categoryOf(g, a.node)) - order.indexOf(categoryOf(g, b.node)) || a.depth - b.depth || a.node.localeCompare(b.node));
  if (direct.length > 0) {
    io.log('  directly:');
    for (const line of cap(sortDeps(direct).map((d) => `${nodeLabel(g, d.node)}  ${io.c.dim(relation(d.via))}`))) io.log(`    ${line}`);
  }
  if (indirect.length > 0) {
    io.log('  indirectly:');
    for (const line of cap(sortDeps(indirect).map((d) => `${nodeLabel(g, d.node)}  ${io.c.dim(`${relation(d.via)} (${d.depth} steps)`)}`))) {
      io.log(`    ${line}`);
    }
  }

  if (r.broken.length > 0) {
    io.log();
    io.log(io.c.red(io.c.bold(`Broken imports (${r.broken.length}):`)));
    for (const b of r.broken) io.log(`  ${io.c.red(brokenTitle(b))}`);
  }
  io.log();
  io.log(
    io.c.dim(
      `Graph: ${plural(r.stats.files, 'file')}, ${plural(r.stats.edges, 'edge')}, ${plural(r.stats.routes, 'API route')}, ${plural(r.stats.tables, 'table')} ` +
        `(${r.stats.parsed} parsed, ${r.stats.cached} cached, ${(r.stats.ms / 1000).toFixed(1)}s)`,
    ),
  );
}
