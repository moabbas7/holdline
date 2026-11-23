import { describe, expect, it } from 'vitest';
import { buildFeedback } from '../src/hooks/feedback.js';
import { agree, plural } from '../src/plural.js';
import { dependentsTitle, summarizeDependents } from '../src/probes/dependencies/format.js';
import { dependentsOf, indexGraph } from '../src/probes/dependencies/graph.js';
import { compareGraphs } from '../src/probes/dependencies/index.js';
import type { DepGraph, FileRole } from '../src/probes/dependencies/types.js';
import { summarize, type ReportFinding, type ScopedReport } from '../src/report/model.js';
import { rippleReason } from '../src/scope/classify.js';

// Every noun holdline counts in its output, with its plural when it isn't just + "s".
const NOUNS: [string, string?][] = [
  ['page'], ['file'], ['API route'], ['route'], ['table'], ['view'], ['enum'], ['edge'], ['change'], ['regression'],
  ['difference'], ['request'], ['problem'], ['warning'], ['check'], ['statement'], ['thing'], ['note'], ['region'],
  ['snapshot ref'], ['older snapshot'], ['old snapshot'], ['holdline hook'], ['holdline handler'], ['fix round'],
  ['automatic fix round'], ['caller'], ['call'], ['reload'], ['dependent'], ['changed file'], ['new broken import'],
  ['breaking schema change'], ['other schema change'], ['breaking API change'], ['other API change'], ['visual difference'],
  ['reference'], ['line'], ['more file'], ['policy', 'policies'],
];
// Every verb or pronoun that agrees with a count: [singular, plural].
const AGREEING: [string, string][] = [
  ['depends', 'depend'], ['uses', 'use'], ['affects', 'affect'], ['is', 'are'], ['was', 'were'], ['it', 'them'], ['it was', 'they were'],
];

describe('plural', () => {
  it.each(NOUNS)('%s: 0 and 2+ are plural, 1 is singular', (one, many = `${one}s`) => {
    expect(plural(0, one, many)).toBe(`0 ${many}`);
    expect(plural(1, one, many)).toBe(`1 ${one}`);
    expect(plural(2, one, many)).toBe(`2 ${many}`);
    expect(plural(1000, one, many)).toBe(`1000 ${many}`);
  });

  it('defaults the plural to + "s"', () => {
    expect(plural(2, 'page')).toBe('2 pages');
    expect(plural(2, 'policy', 'policies')).toBe('2 policies');
  });

  it.each(AGREEING)('%s / %s agree with 0, 1 and 2', (one, many) => {
    expect(agree(0, one, many)).toBe(many);
    expect(agree(1, one, many)).toBe(one);
    expect(agree(2, one, many)).toBe(many);
  });
});

// --- Call sites that used to get it wrong ---------------------------------------------------

/** lib/a.ts plus `pages` pages and `files` plain files that import it. */
function graph(pages: number, files: number, hash = 'h1'): DepGraph {
  const g: DepGraph = {
    version: 1,
    files: { 'lib/a.ts': { hash, role: 'module' } },
    routes: {},
    tables: {},
    edges: [],
    broken: [],
    unmatchedCalls: [],
    stats: { files: 0, edges: 0, routes: 0, tables: 0, broken: 0, parsed: 0, cached: 0, ms: 0 },
  };
  const add = (p: string, role: FileRole) => {
    g.files[p] = { hash: 'x', role };
    g.edges.push({ from: p, to: 'lib/a.ts', type: 'import' });
  };
  for (let i = 0; i < pages; i++) add(`app/p${i}/page.tsx`, 'page');
  for (let i = 0; i < files; i++) add(`lib/u${i}.ts`, 'module');
  return g;
}
const deps = (g: DepGraph) => dependentsOf(indexGraph(g), 'lib/a.ts');

describe('dependency summaries', () => {
  it('"→ N … depend(s) on it" agrees with the total number of dependents', () => {
    const cases: [number, number, string][] = [
      [1, 0, '1 page depends on it'],
      [0, 1, '1 file depends on it'],
      [2, 0, '2 pages depend on it'],
      [1, 1, '1 page, 1 file depend on it'],
      [4, 1, '4 pages, 1 file depend on it'],
    ];
    for (const [pages, files, text] of cases) {
      const g = graph(pages, files);
      expect(dependentsTitle(g, 'lib/a.ts', 'modified', deps(g))).toBe(`lib/a.ts (modified) → ${text}`);
    }
    expect(summarizeDependents(graph(0, 0), [])).toBe('');
  });

  it('the probe summary agrees with the number of changed files', () => {
    // A changed file with 1 / 2 dependents.
    expect(compareGraphs(graph(1, 0), graph(1, 0, 'h2')).summary).toBe('1 changed file affects 1 dependent (files, pages, API routes, tables)');
    expect(compareGraphs(graph(1, 1), graph(1, 1, 'h2')).summary).toBe('1 changed file affects 2 dependents (files, pages, API routes, tables)');
    expect(compareGraphs(graph(1, 0), graph(1, 0, 'h2')).findings[0]?.title).toBe('lib/a.ts (modified) → 1 page depends on it');

    // Changed files nothing depends on: "it" for one, "them" for two.
    const lone = (n: number, hash: string): DepGraph => {
      const g = graph(0, 0);
      g.files = {};
      for (let i = 0; i < n; i++) g.files[`lib/z${i}.ts`] = { hash, role: 'module' };
      return g;
    };
    expect(compareGraphs(lone(1, 'a'), lone(1, 'b')).summary).toBe('1 changed file, nothing else depends on it');
    expect(compareGraphs(lone(2, 'a'), lone(2, 'b')).summary).toBe('2 changed files, nothing else depends on them');
    expect(compareGraphs(lone(1, 'a'), lone(1, 'a')).summary).toBe('no source files changed');
  });

  it('the expected-ripple reason agrees with both counts', () => {
    const tail = 'which the agent changed for the task';
    expect(rippleReason('lib/a.ts', 1, 1)).toBe(`1 file uses lib/a.ts, ${tail}`);
    expect(rippleReason('lib/a.ts', 2, 2)).toBe(`2 files use lib/a.ts, ${tail}`);
    expect(rippleReason('lib/a.ts', 0, 1)).toBe(`0 files use lib/a.ts (1 depends on it in all), ${tail}`);
    expect(rippleReason('lib/a.ts', 1, 2)).toBe(`1 file uses lib/a.ts (2 depend on it in all), ${tail}`);
    expect(rippleReason('lib/a.ts', 3, 5)).toBe(`3 files use lib/a.ts (5 depend on it in all), ${tail}`);
  });
});

// --- Feedback to agents and the report summary ------------------------------------------------

function finding(f: Partial<ReportFinding>): ReportFinding {
  return { id: 'x', probe: 'checks', kind: 'regression', severity: 'critical', scope: 'outside-scope', reason: 'r', title: 't', files: [], lines: [], notes: [], ...f };
}
function report(findings: ReportFinding[], edited = { inScope: 0, ripple: 0, outside: 0 }): ScopedReport {
  return { findings, scope: { edited }, htmlReport: 'r.html', rollbackCommand: 'holdline rollback' } as unknown as ScopedReport;
}
const many = (n: number, f: Partial<ReportFinding>) => Array.from({ length: n }, (_, i) => finding({ ...f, id: `f${i}`, title: `Thing ${i}` }));

describe('feedback to agents', () => {
  it.each([
    [0, '0 things that worked before this task are broken now.'],
    [1, '1 thing that worked before this task is broken now.'],
    [2, '2 things that worked before this task are broken now.'],
  ])('%i broken', (n, text) => {
    const first = buildFeedback({ report: report(many(n, {})), round: 1 }).split('\n')[0];
    expect(first).toBe(`holdline checked the project after your changes: ${text}`);
  });
});

describe('report summary', () => {
  it.each([
    [1, 'The task\'s changes broke 1 thing that uses them'],
    [2, 'The task\'s changes broke 2 things that use them'],
  ])('%i broken by the task', (n, text) => {
    expect(summarize(report(many(n, { scope: 'broken-by-task' })))[0]).toMatch(new RegExp(`^${text}: `));
  });

  it.each([
    [0, 1, 'Nothing broke, but 1 change landed outside the task area; review it below.'],
    [1, 1, 'Nothing broke, but the agent edited 1 file outside the task area (1 change to review below).'],
    [2, 2, 'Nothing broke, but the agent edited 2 files outside the task area (2 changes to review below).'],
  ])('%i files edited outside, %i changes', (outside, n, text) => {
    expect(summarize(report(many(n, { kind: 'change' }), { inScope: 0, ripple: 0, outside }))[0]).toBe(text);
  });

  it.each([
    [0, 'Edited: 0 files in the task area, 1 outside it.'],
    [1, 'Edited: 1 file in the task area, 1 outside it.'],
    [2, 'Edited: 2 files in the task area, 1 outside it.'],
  ])('%i files edited in the task area', (inScope, text) => {
    expect(summarize(report(many(1, { kind: 'change' }), { inScope, ripple: 0, outside: 1 })).at(-1)).toBe(text);
  });
});
