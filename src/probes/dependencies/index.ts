import { tagOf, type Finding, type Probe, type ProbeReport } from '../types.js';
import { brokenKey, brokenTitle, describeDependents, summarizeDependents } from './format.js';
import { buildGraph, dependentsOf, indexGraph, rememberGraph, type GraphIndex } from './graph.js';
import { readGraph, writeGraph } from './store.js';
import type { BrokenImport, DepGraph, DepGraphRef } from './types.js';

const MAX_BLAST_FINDINGS = 30;

/** The importing file is the subject; the import's target (when resolved) is what it points at. */
const brokenMeta = (br: BrokenImport) => ({ files: [br.file], locations: [{ file: br.file, line: br.line }] });

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const dependenciesProbe: Probe<DepGraphRef> = {
  id: 'dependencies',
  title: 'Dependencies',

  enabled(config) {
    return config.probes?.dependencies?.enabled !== false;
  },

  async snapshot(ctx) {
    ctx.io.progress('  dependency graph …');
    const graph = await buildGraph(ctx.root, { projectType: ctx.config.projectType });
    const ref = await writeGraph(ctx.root, tagOf(ctx), graph);
    rememberGraph(ctx.root, ctx.snapshotSha, graph);
    const s = graph.stats;
    ctx.io.progressDone(
      ctx.io.c.dim(
        `Dependency graph: ${plural(s.files, 'file')}, ${plural(s.edges, 'edge')}, ${plural(s.routes, 'API route')}, ${plural(s.tables, 'table')} ` +
          `(${s.parsed} parsed, ${s.cached} cached, ${(s.ms / 1000).toFixed(1)}s)`,
      ),
    );
    return ref;
  },

  async saveBaseline(ref) {
    return ref;
  },

  async restoreBaseline(kept, ctx) {
    const g = await readGraph(ctx.root, kept as DepGraphRef);
    if ('error' in g) return null;
    rememberGraph(ctx.root, ctx.snapshotSha, g.graph);
    return writeGraph(ctx.root, tagOf(ctx), g.graph);
  },

  async compare(beforeRef, afterRef, ctx) {
    const skipped = (why: string): ProbeReport => ({
      probeId: 'dependencies',
      title: this.title,
      status: 'skipped',
      summary: why,
      findings: [],
    });
    const b = await readGraph(ctx.root, beforeRef);
    if ('error' in b) return skipped(`graph from \`holdline before\` unavailable (${b.error}); run before again`);
    const a = await readGraph(ctx.root, afterRef);
    if ('error' in a) return skipped(`graph from \`holdline after\` unavailable (${a.error})`);
    return compareGraphs(b.graph, a.graph, this.title, ctx.ownOutputs?.excluded);
  },
};

export function compareGraphs(before: DepGraph, after: DepGraph, title = 'Dependencies', notAgentChanges?: Set<string>): ProbeReport {
  const findings: Finding[] = [];

  // Broken imports: new ones are regressions.
  const beforeBroken = new Set(before.broken.map(brokenKey));
  const afterBroken = new Set(after.broken.map(brokenKey));
  let newBroken = 0;
  for (const br of after.broken) {
    if (beforeBroken.has(brokenKey(br))) {
      findings.push({ kind: 'still-failing', title: `${brokenTitle(br)} (already broken before the task)`, path: br.file, meta: brokenMeta(br) });
    } else {
      newBroken++;
      findings.push({ kind: 'regression', title: `Broken import: ${brokenTitle(br)}`, path: br.file, meta: brokenMeta(br) });
    }
  }
  for (const br of before.broken) {
    if (!afterBroken.has(brokenKey(br)) && after.files[br.file]) {
      findings.push({ kind: 'fixed', title: `No longer broken: ${brokenTitle(br)}`, path: br.file, meta: brokenMeta(br) });
    }
  }

  // Changed files and their blast radius.
  const changed: { path: string; status: 'added' | 'modified' | 'deleted' }[] = [];
  for (const [p, f] of Object.entries(after.files)) {
    const old = before.files[p];
    if (!old) changed.push({ path: p, status: 'added' });
    else if (old.hash !== f.hash) changed.push({ path: p, status: 'modified' });
  }
  for (const p of Object.keys(before.files)) if (!after.files[p]) changed.push({ path: p, status: 'deleted' });
  if (notAgentChanges?.size) {
    for (let i = changed.length - 1; i >= 0; i--) if (notAgentChanges.has(changed[i]!.path)) changed.splice(i, 1);
  }
  changed.sort((x, y) => x.path.localeCompare(y.path));

  const idxAfter = indexGraph(after);
  let idxBefore: GraphIndex | null = null;
  const blast: Finding[] = [];
  const reached = new Set<string>();
  for (const c of changed) {
    const idx = c.status === 'deleted' ? (idxBefore ??= indexGraph(before)) : idxAfter;
    const graph = c.status === 'deleted' ? before : after;
    const deps = dependentsOf(idx, c.path);
    if (deps.length === 0) continue;
    for (const d of deps) reached.add(d.node);
    blast.push({
      kind: 'change',
      title: `${c.path} (${c.status}) → ${summarizeDependents(graph, deps)} depend on it`,
      path: c.path,
      lines: describeDependents(graph, deps),
      meta: { files: [c.path], affects: deps.filter((d) => graph.files[d.node]).map((d) => d.node) },
    });
  }
  findings.push(...blast.slice(0, MAX_BLAST_FINDINGS));
  if (blast.length > MAX_BLAST_FINDINGS) {
    findings.push({
      kind: 'info',
      title: `…and ${blast.length - MAX_BLAST_FINDINGS} more changed files with dependents (run \`holdline graph <file>\` for any of them)`,
    });
  }

  const parts: string[] = [];
  if (changed.length === 0) parts.push('no source files changed');
  else if (blast.length === 0) parts.push(`${plural(changed.length, 'changed file')}, nothing else depends on them`);
  else parts.push(`${plural(changed.length, 'changed file')} affect ${plural(reached.size, 'dependent')} (files, pages, API routes, tables)`);
  if (newBroken > 0) parts.push(`${plural(newBroken, 'new broken import')}`);

  return {
    probeId: 'dependencies',
    title,
    status: newBroken > 0 ? 'regressed' : blast.length > 0 ? 'changed' : 'ok',
    summary: parts.join('; '),
    findings,
  };
}
