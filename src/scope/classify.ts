/**
 * Classifies every finding as in scope (the task's own area), expected ripple (direct
 * dependents of files changed for the task) or outside scope, with a one-line reason.
 *
 * - Scope files: files the task text or a --scope glob names ("core"), plus files the agent
 *   edited that are attached to them: next to a core file in a small folder (≤ 10 source
 *   files), importing or imported by a core file, or imported by another attached file.
 *   With no core at all, the agent's edits are the scope.
 * - Ripple: direct dependents of scope files the agent changed (API routes and tables are
 *   looked through: callers of a changed handler, users of a changed table), and pages or
 *   layouts that render a changed scope file at any depth.
 * - Everything else is outside scope. A regression whose subject is in scope but which
 *   breaks code outside it (a dropped column still read elsewhere) counts as outside.
 */
import path from 'node:path';
import { indexGraph, dependentsOf, type GraphIndex } from '../probes/dependencies/graph.js';
import { matchRoute } from '../probes/dependencies/routes.js';
import type { DepGraph } from '../probes/dependencies/types.js';
import type { Finding, FindingMeta, ProbeReport } from '../probes/types.js';
import { matchesScopeGlob, pageFiles, segmentWords, termMatchesFile, toPattern, type TaskScope } from './taskScope.js';

export type ScopeClass = 'in-scope' | 'expected-ripple' | 'outside-scope';
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export const SCOPE_RANK: Record<ScopeClass, number> = { 'in-scope': 0, 'expected-ripple': 1, 'outside-scope': 2 };
export const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

/** Small folders are feature folders: a file next to a task file there belongs to the task. */
export const SMALL_DIR_MAX = 10;
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|css|scss|sass|less|html?|vue|svelte|astro|mdx?|sql|prisma)$/i;

export interface EditedFile {
  path: string;
  status: string;
  oldPath?: string;
}

export interface ClassifyInput {
  scope: TaskScope;
  beforeFiles: string[];
  afterFiles: string[];
  beforeGraph: DepGraph | null;
  afterGraph: DepGraph | null;
  /** The agent's changes (files written only by holdline's own build already removed). */
  edited: EditedFile[];
  /** Files the build wrote in `before` that the agent then changed. */
  ownEdited?: Set<string>;
  reports: ProbeReport[];
  /** probes.visual.failOnUnexpectedChange */
  failOnUnexpectedVisual?: boolean;
  /** Absolute project root, to turn absolute paths in check output into project paths. */
  root?: string;
}

export interface ClassifiedFinding {
  probe: string;
  probeTitle: string;
  kind: Finding['kind'];
  severity: Severity;
  scope: ScopeClass;
  reason: string;
  title: string;
  detail?: string;
  lines?: string[];
  files: string[];
  locations: { file: string; line: number; text?: string }[];
  meta: FindingMeta;
}

export interface ScopeArea {
  /** Terms that matched something: text → number of files. */
  terms: { text: string; kind: string; files: number; routes: string[]; tables: string[] }[];
  dropped: { text: string; why: string }[];
  unmatched: string[];
  globs: { glob: string; files: number }[];
  fallback: boolean;
  files: string[];
  routes: string[];
  tables: string[];
  edited: { inScope: number; ripple: number; outside: number };
}

export interface Classification {
  findings: ClassifiedFinding[];
  area: ScopeArea;
}

interface Level {
  scope: ScopeClass;
  reason: string;
}

const q = (s: string) => `"${s}"`;
const dirOf = (f: string) => (f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '');
const dirLabel = (d: string) => (d ? `${d}/` : 'the project root');

export function severityOf(probe: string, kind: Finding['kind']): Severity {
  if (kind === 'regression') {
    if (probe === 'database' || probe === 'api') return 'high';
    if (probe === 'visual') return 'medium';
    return 'critical';
  }
  if (kind === 'change') return 'low';
  return 'info';
}

export class ScopeModel {
  readonly inScope = new Map<string, string>();
  readonly ripple = new Map<string, string>();
  readonly routeIn = new Map<string, string>();
  readonly tableIn = new Map<string, string>();
  readonly edited = new Set<string>();
  readonly changedForTask = new Set<string>();
  /** How strongly each core file is tied to the task (0: a path or glob … 4: a single word). */
  private readonly corePriority = new Map<string, number>();
  readonly area: ScopeArea;
  private readonly files: Set<string>;
  private readonly pages: { file: string; pattern: string }[];
  private readonly layouts: string[];
  private readonly idxAfter: GraphIndex | null;
  private readonly idxBefore: GraphIndex | null;
  private readonly fallback: boolean;

  constructor(private readonly input: ClassifyInput) {
    const { scope } = input;
    this.files = new Set([...input.beforeFiles, ...input.afterFiles]);
    const allFiles = [...this.files].sort();
    this.pages = pageFiles(input.afterFiles.length ? input.afterFiles : input.beforeFiles);
    this.layouts = allFiles.filter((f) => /(?:^|\/)app\/(?:.*\/)?layout\.[cm]?[jt]sx?$/.test(f));
    this.idxAfter = input.afterGraph ? indexGraph(input.afterGraph) : null;
    this.idxBefore = input.beforeGraph ? indexGraph(input.beforeGraph) : null;

    // 1. Core: what the task text and --scope globs name.
    const ORDER = ['path', 'route', 'name', 'phrase', 'word'];
    const terms = [...scope.terms].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
    for (const t of terms) {
      if (t.dropped) continue;
      for (const f of t.files) {
        if (this.inScope.has(f)) continue;
        this.corePriority.set(f, ORDER.indexOf(t.kind));
        this.inScope.set(f, t.kind === 'path' ? `is named in the task (${q(t.text)})` : t.kind === 'route' ? `serves ${t.text}, named in the task` : `matches ${q(t.text)} in the task`);
      }
      for (const f of t.tableFiles) if (!this.inScope.has(f)) this.inScope.set(f, `defines table ${t.tables.join(', ')}, which matches ${q(t.text)} in the task`);
      for (const r of t.routes) if (!this.routeIn.has(r)) this.routeIn.set(r, `${r} is named in the task`);
      for (const tb of t.tables) if (!this.tableIn.has(tb)) this.tableIn.set(tb, `table ${tb} matches ${q(t.text)} in the task`);
    }
    const globCounts: { glob: string; files: number }[] = [];
    for (const g of scope.globs) {
      let n = 0;
      for (const f of allFiles) {
        if (!matchesScopeGlob(f, g)) continue;
        n++;
        if (!this.inScope.has(f)) {
          this.inScope.set(f, `matches --scope ${q(g)}`);
          this.corePriority.set(f, 0);
        }
      }
      globCounts.push({ glob: g, files: n });
    }
    // Routes named by the task make their handler files core too.
    for (const r of this.routeIn.keys()) {
      for (const f of input.afterGraph?.routes[r]?.files ?? input.beforeGraph?.routes[r]?.files ?? []) {
        if (this.inScope.has(f)) continue;
        this.inScope.set(f, `handles ${r}, named in the task`);
        this.corePriority.set(f, 1);
      }
    }
    const tableDefs = new Set(scope.terms.flatMap((t) => (t.dropped ? [] : t.tableFiles)));
    const core = new Set(this.inScope.keys());
    this.fallback = core.size === 0 && this.routeIn.size === 0 && this.tableIn.size === 0;

    // 2. The agent's edits that belong to the task area.
    const editedPaths = new Set<string>();
    for (const e of input.edited) {
      editedPaths.add(e.path);
      if (e.oldPath) editedPaths.add(e.oldPath);
    }
    for (const p of editedPaths) this.edited.add(p);
    const dirCount = new Map<string, number>();
    for (const f of allFiles) if (SOURCE_FILE.test(f)) dirCount.set(dirOf(f), (dirCount.get(dirOf(f)) ?? 0) + 1);
    const coreByDir = new Map<string, string>();
    // Migrations that merely define a task table don't make their (chronological) folder the task's.
    for (const f of [...core].sort()) if (!tableDefs.has(f) && !coreByDir.has(dirOf(f))) coreByDir.set(dirOf(f), f);

    if (this.fallback) {
      for (const p of editedPaths) this.inScope.set(p, 'was edited by the agent (the task text matched nothing in the project, so the edited files are taken as the task area)');
    } else {
      // Files the agent created or renamed: match them against the task's terms too.
      for (const p of [...editedPaths].sort()) {
        if (this.inScope.has(p)) continue;
        const t = terms.find((x) => !x.dropped && termMatchesFile(x, p));
        if (t) this.inScope.set(p, t.kind === 'path' ? `is named in the task (${q(t.text)})` : `matches ${q(t.text)} in the task`);
      }
      for (const p of [...editedPaths].sort()) {
        if (this.inScope.has(p)) continue;
        const d = dirOf(p);
        const neighbour = coreByDir.get(d);
        if (neighbour && (dirCount.get(d) ?? 0) <= SMALL_DIR_MAX) {
          this.inScope.set(p, `sits next to ${neighbour} (part of the task) in ${dirLabel(d)}, a small folder`);
          continue;
        }
        const link = this.importLink(p, core);
        if (link) this.inScope.set(p, `${link.dir === 'out' ? 'imports' : 'is imported by'} ${link.other}, which ${this.inScope.get(link.other)}`);
      }
      // New helpers pulled in by attached files: imported by a file already attached.
      for (let changed = true; changed; ) {
        changed = false;
        for (const p of [...editedPaths].sort()) {
          if (this.inScope.has(p)) continue;
          const attached = new Set([...editedPaths].filter((e) => this.inScope.has(e)));
          const link = this.importLink(p, attached, 'in');
          if (link) {
            this.inScope.set(p, `is imported by ${link.other}, which the agent changed for the task`);
            changed = true;
          }
        }
      }
    }
    for (const p of editedPaths) if (this.inScope.has(p)) this.changedForTask.add(p);
    // Tables changed by a migration or schema file that belongs to the task.
    for (const g of [input.afterGraph, input.beforeGraph]) {
      for (const [tb, info] of Object.entries(g?.tables ?? {})) {
        const f = info.definedIn.find((x) => this.changedForTask.has(x));
        if (f && !this.tableIn.has(tb)) this.tableIn.set(tb, `table ${tb} is changed by ${f}, which the task covers`);
      }
    }

    // 3. Ripple: direct dependents of files changed for the task.
    for (const f of [...this.changedForTask].sort()) this.addRipple(f);

    const editedCount = { inScope: 0, ripple: 0, outside: 0 };
    for (const p of input.edited.map((e) => e.path)) {
      if (this.inScope.has(p)) editedCount.inScope++;
      else if (this.ripple.has(p)) editedCount.ripple++;
      else editedCount.outside++;
    }
    this.area = {
      terms: scope.terms.filter((t) => !t.dropped && (t.files.length || t.routes.length || t.tables.length)).map((t) => ({ text: t.text, kind: t.kind, files: t.files.length, routes: t.routes, tables: t.tables })),
      dropped: scope.terms.filter((t) => t.dropped).map((t) => ({ text: t.text, why: t.dropped! })),
      unmatched: scope.terms.filter((t) => !t.dropped && !t.files.length && !t.routes.length && !t.tables.length && t.kind !== 'phrase').map((t) => t.text),
      globs: globCounts,
      fallback: this.fallback,
      files: [...this.inScope.keys()].sort(),
      routes: [...this.routeIn.keys()].sort(),
      tables: [...this.tableIn.keys()].sort(),
      edited: editedCount,
    };
  }

  /**
   * A direct import between `p` and one of `targets` (dir 'out': p imports it). The file most
   * strongly tied to the task wins; being imported by it beats importing it.
   */
  private importLink(p: string, targets: Set<string>, only?: 'in' | 'out'): { other: string; dir: 'in' | 'out' } | null {
    const found: { other: string; dir: 'in' | 'out' }[] = [];
    for (const idx of [this.idxAfter, this.idxBefore]) {
      if (!idx) continue;
      if (only !== 'in') {
        for (const e of idx.out.get(p) ?? []) if ((e.type === 'import' || e.type === 'server-action') && targets.has(e.to)) found.push({ other: e.to, dir: 'out' });
      }
      if (only !== 'out') {
        for (const e of idx.in.get(p) ?? []) if ((e.type === 'import' || e.type === 'server-action') && targets.has(e.from)) found.push({ other: e.from, dir: 'in' });
      }
    }
    const rank = (x: { other: string; dir: 'in' | 'out' }) => (this.corePriority.get(x.other) ?? 5) * 2 + (x.dir === 'in' ? 0 : 1);
    found.sort((a, b) => rank(a) - rank(b) || a.other.localeCompare(b.other));
    return found[0] ?? null;
  }

  private isFile(node: string): boolean {
    return !node.startsWith('route:') && !node.startsWith('table:');
  }

  /**
   * Files that use what `f` exports: direct importers, and importers through re-exporting
   * files (barrels like `index.ts` or a package entry), matched by the names they import.
   * Graphs without import names (older versions) fall back to direct importers.
   */
  usersOf(f: string): { file: string; names: string[]; via?: string; barrel?: boolean }[] {
    const out = new Map<string, { file: string; names: string[]; via?: string; barrel?: boolean }>();
    for (const [idx, graph] of [
      [this.idxAfter, this.input.afterGraph],
      [this.idxBefore, this.input.beforeGraph],
    ] as const) {
      if (!idx || !graph) continue;
      const exp = graph.files[f]?.exports;
      const queue: { node: string; names: Set<string> | null; depth: number }[] = [{ node: f, names: exp ? new Set(exp) : null, depth: 0 }];
      const seen = new Set([f]);
      while (queue.length) {
        const it = queue.shift()!;
        for (const e of idx.in.get(it.node) ?? []) {
          if (e.type !== 'import' && e.type !== 'server-action') continue;
          const x = e.from;
          if (e.reexports && it.depth < 6) {
            const pass = e.reexports.includes('*') ? it.names : new Set(e.reexports.filter((n) => !it.names || it.names.has(n)));
            if ((!pass || pass.size > 0) && !seen.has(x)) {
              seen.add(x);
              queue.push({ node: x, names: pass, depth: it.depth + 1 });
              if (it.depth === 0 && !out.has(x)) out.set(x, { file: x, names: [], barrel: true });
            }
          }
          if (e.names) {
            const hit = e.names.length === 0 || e.names.includes('*') || !it.names ? [] : e.names.filter((n) => it.names!.has(n));
            const uses = e.names.length === 0 || e.names.includes('*') || !it.names || hit.length > 0;
            // `via`: the re-exporting file this one imports (what its import statement names).
            if (uses && !out.has(x)) out.set(x, { file: x, names: hit, ...(it.depth > 0 ? { via: it.node } : {}) });
          } else if (!e.reexports && !out.has(x)) {
            out.set(x, { file: x, names: [], ...(it.depth > 0 ? { via: it.node } : {}) });
          }
        }
      }
    }
    out.delete(f);
    return [...out.values()].sort((a, b) => a.file.localeCompare(b.file));
  }

  private addRipple(f: string): void {
    const add = (file: string, reason: string) => {
      if (!this.inScope.has(file) && !this.ripple.has(file) && this.isFile(file)) this.ripple.set(file, reason);
    };
    const users = this.usersOf(f);
    for (const u of users) {
      if (u.barrel) add(u.file, `re-exports ${f}, which the agent changed for the task`);
      else {
        const what = u.names.length ? `${u.names.slice(0, 2).join(', ')}${u.names.length > 2 ? ', …' : ''} from ${f}` : f;
        add(u.file, `${u.via ? `uses ${what} (through ${u.via})` : `imports ${what}`}, which the agent changed for the task`);
      }
    }
    for (const idx of [this.idxAfter, this.idxBefore]) {
      if (!idx) continue;
      // API routes and tables are looked through, to the code behind them.
      for (const d of dependentsOf(idx, f, 1)) {
        if (this.isFile(d.node)) continue;
        for (const d2 of dependentsOf(idx, d.node, 1)) {
          if (!this.isFile(d2.node)) continue;
          if (d.node.startsWith('route:')) add(d2.node, `calls ${d.node.slice(6)}, whose handler ${f} the agent changed for the task`);
          else add(d2.node, `uses table ${d.node.slice(6)}, which ${f} changes for the task`);
        }
      }
      // Pages and layouts that render the changed file or one of its users, at any depth.
      // (Through its users, not through barrels: importing a barrel doesn't mean using `f`.)
      for (const start of users.filter((u) => !u.barrel).map((u) => u.file)) {
        for (const d of dependentsOf(idx, start)) {
          if (!this.isFile(d.node) || this.ripple.has(d.node) || this.inScope.has(d.node)) continue;
          if (this.pages.some((p) => p.file === d.node) || this.layouts.includes(d.node)) {
            add(d.node, `renders ${start}, which uses ${f} (changed for the task)`);
          }
        }
      }
    }
    // A changed layout wraps every page below it.
    if (this.layouts.includes(f)) {
      const base = dirOf(f);
      for (const p of this.pages) if (p.file.startsWith(base ? `${base}/` : '')) add(p.file, `is rendered inside ${f}, which the agent changed for the task`);
    }
  }

  /** How a file relates to the task, as a verb phrase ("matches "users" in the task"). */
  fileWhy(f: string): { scope: ScopeClass; why: string } {
    const own = this.input.ownEdited?.has(f) ? ' (your build also wrote this file in `before`, but the agent changed it since, so it counts as an agent change)' : '';
    const inR = this.inScope.get(f);
    if (inR) return { scope: 'in-scope', why: `${inR}${own}` };
    const rip = this.ripple.get(f);
    if (rip) return { scope: 'expected-ripple', why: `${rip}${own}` };
    if (this.edited.has(f)) {
      return { scope: 'outside-scope', why: `was edited by the agent, but the task doesn't name it and it isn't next to or imported by a file the task covers${own}` };
    }
    return { scope: 'outside-scope', why: "isn't named by the task and doesn't directly use a file changed for it" };
  }

  fileLevel(f: string): Level {
    const w = this.fileWhy(f);
    return { scope: w.scope, reason: `${f} ${w.why}` };
  }

  /** Page files (and the layouts around them) that serve a URL. */
  pageFilesFor(url: string): string[] {
    const u = url.split('?')[0]!.split('#')[0]!;
    const scored = this.pages.map((p) => ({ p, s: matchRoute(u, p.pattern) })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s);
    if (!scored.length) return [];
    const page = scored[0]!.p.file;
    const out = [page];
    for (const l of this.layouts) {
      const d = dirOf(l);
      if (page.startsWith(`${d}/`)) out.push(l);
    }
    return out;
  }

  pageLevel(url: string): Level {
    const files = this.pageFilesFor(url);
    const page = files[0];
    for (const f of files) {
      const r = this.inScope.get(f);
      if (r) return { scope: 'in-scope', reason: f === page ? `page ${url} is ${f}, which ${r}` : `page ${url} is rendered inside ${f}, which ${r}` };
    }
    for (const f of files) {
      const r = this.ripple.get(f);
      if (r) return { scope: 'expected-ripple', reason: `page ${url} (${f}) ${r}` };
    }
    // No page file (or not in scope): compare the URL with the task's routes and words.
    const u = toPattern(url.split('?')[0]!);
    for (const t of this.input.scope.terms) {
      if (t.dropped) continue;
      if (t.kind === 'route' && matchRoute(u, toPattern(t.text)) >= 0) return { scope: 'in-scope', reason: `page ${url} is named in the task` };
    }
    const urlWords = new Set(segmentWords(u.replace(/^\//, '')).flat());
    for (const t of this.input.scope.terms) {
      if (t.dropped || t.kind !== 'word') continue;
      if (urlWords.has(t.words[0] ?? t.text)) return { scope: 'in-scope', reason: `page ${url} matches ${q(t.text)} in the task` };
    }
    if (this.fallback) return { scope: 'outside-scope', reason: `page ${url} doesn't render any file the agent edited` };
    return { scope: 'outside-scope', reason: page ? `page ${url} (${page}) isn't named by the task and doesn't render a file changed for it` : `page ${url} isn't named by the task` };
  }

  routeLevel(pattern: string): Level {
    const r = this.routeIn.get(pattern);
    if (r) return { scope: 'in-scope', reason: r };
    const files = this.input.afterGraph?.routes[pattern]?.files ?? this.input.beforeGraph?.routes[pattern]?.files ?? [];
    for (const f of files) {
      const s = this.inScope.get(f);
      if (s) return { scope: 'in-scope', reason: `${pattern} is handled by ${f}, which ${s}` };
    }
    for (const f of files) {
      const s = this.ripple.get(f);
      if (s) return { scope: 'expected-ripple', reason: `${pattern} is handled by ${f}, which ${s}` };
    }
    return { scope: 'outside-scope', reason: `${pattern} isn't named by the task and its handler${files.length ? ` (${files[0]})` : ''} isn't part of it` };
  }

  tableLevel(table: string): Level {
    const r = this.tableIn.get(table);
    if (r) return { scope: 'in-scope', reason: r };
    return { scope: 'outside-scope', reason: `table ${table} isn't named by the task and no file changed for the task defines it` };
  }

  /** Project files named in free text (check output): `src/x.ts(3,4)`, `/abs/root/src/x.ts:3:4`. */
  filesInText(text: string): { file: string; line?: number }[] {
    const out: { file: string; line?: number }[] = [];
    const seen = new Set<string>();
    const root = this.input.root ? this.input.root.split(path.sep).join('/') + '/' : null;
    const re = /([\w@.~\-[\]()+/\\]+\.[A-Za-z]{1,6})(?:[:(](\d+))?/g;
    for (const m of text.matchAll(re)) {
      let p = m[1]!.replace(/\\/g, '/');
      if (root && p.startsWith(root)) p = p.slice(root.length);
      p = p.replace(/^\.\//, '');
      if (!this.files.has(p)) {
        // Tools often print paths relative to a package folder (monorepos): try a suffix match.
        const hit = p.includes('/') ? [...this.files].find((f) => f.endsWith(`/${p}`)) : undefined;
        if (!hit) continue;
        p = hit;
      }
      const key = `${p}:${m[2] ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ file: p, ...(m[2] ? { line: Number(m[2]) } : {}) });
      if (out.length >= 50) break;
    }
    return out;
  }
}

const best = (levels: Level[]): Level | null => (levels.length ? [...levels].sort((a, b) => SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope])[0]! : null);

export function classify(input: ClassifyInput): Classification {
  const model = new ScopeModel(input);
  const out: ClassifiedFinding[] = [];
  for (const rep of input.reports) {
    for (const f of rep.findings) out.push(classifyOne(model, rep, f, input));
  }
  return { findings: out, area: model.area };
}

function classifyOne(model: ScopeModel, rep: ProbeReport, f: Finding, input: ClassifyInput): ClassifiedFinding {
  const meta: FindingMeta = { ...(f.meta ?? {}) };
  let kind = f.kind;
  let title = f.title;
  const locations = [...(meta.locations ?? [])];

  // Subjects: what the finding is about.
  const files = new Set<string>(meta.files ?? (f.path ? [f.path] : []));
  let level: Level | null;
  if (rep.probeId === 'checks') {
    // The output names the files with errors (the command line and log path are not output).
    const output = (f.detail ?? '').split('\n').slice(1).filter((l) => !/^\(full log: /.test(l)).join('\n');
    for (const hit of model.filesInText(output)) {
      files.add(hit.file);
      if (hit.line) locations.push({ file: hit.file, line: hit.line });
    }
    // A failing check is about every file it names: the one furthest from the task decides.
    const worst = [...files].map((file) => ({ file, w: model.fileWhy(file) })).sort((a, b) => SCOPE_RANK[b.w.scope] - SCOPE_RANK[a.w.scope] || a.file.localeCompare(b.file))[0];
    level = worst
      ? { scope: worst.w.scope, reason: `${files.size > 1 ? `errors are in ${files.size} files, including ${worst.file}` : `the error is in ${worst.file}`}, which ${worst.w.why}` }
      : null;
  } else {
    const levels: Level[] = [];
    for (const file of files) levels.push(model.fileLevel(file));
    for (const p of meta.pages ?? []) levels.push(model.pageLevel(p));
    for (const r of meta.routes ?? []) levels.push(model.routeLevel(r));
    for (const t of meta.tables ?? []) levels.push(model.tableLevel(t));
    level = best(levels);
  }
  if (!level) {
    level = {
      scope: 'outside-scope',
      reason:
        rep.probeId === 'checks'
          ? "the output doesn't name a project file, so holdline can't tell whether it is part of the task; shown so it isn't missed"
          : "it doesn't name a file, page, route or table, so holdline can't tell whether it is part of the task; shown so it isn't missed",
    };
  }

  // A dependency summary for a file changed for the task is the task's ripple.
  if (rep.probeId === 'dependencies' && f.kind === 'change' && meta.affects?.length) {
    const subject = [...files][0]!;
    if (model.changedForTask.has(subject)) {
      const users = model.usersOf(subject).filter((u) => !u.barrel).length;
      const all = meta.affects.length;
      level = {
        scope: 'expected-ripple',
        reason:
          users === all
            ? `${all} file${all === 1 ? '' : 's'} use ${subject}, which the agent changed for the task`
            : `${users} file${users === 1 ? '' : 's'} use ${subject} (${all} depend on it in all), which the agent changed for the task`,
      };
    }
  }

  // A regression is as far from the task as the code it breaks: a dropped column of a task
  // table that a file outside the task still reads is outside scope.
  if (kind === 'regression' && level.scope !== 'outside-scope' && rep.probeId !== 'checks') {
    const users = [...new Set([...(meta.affects ?? []), ...locations.map((l) => l.file)])].sort();
    const worst = users.map((u) => ({ u, l: model.fileLevel(u) })).filter((x) => SCOPE_RANK[x.l.scope] > SCOPE_RANK[level!.scope]);
    worst.sort((a, b) => SCOPE_RANK[b.l.scope] - SCOPE_RANK[a.l.scope] || a.u.localeCompare(b.u));
    const top = worst[0];
    if (top) {
      const same = worst.filter((x) => x.l.scope === top.l.scope).length;
      const more = same > 1 ? ` (and ${same - 1} more file${same > 2 ? 's' : ''})` : '';
      level =
        top.l.scope === 'outside-scope'
          ? { scope: 'outside-scope', reason: `${level.reason}, but ${top.u}${more} outside the task still uses it` }
          : { scope: top.l.scope, reason: `${level.reason}; ${top.l.reason}${more}` };
    }
  }

  // Visual differences on pages outside the task are unexpected.
  if (meta.visualDiff && level.scope === 'outside-scope') {
    title = title.replace(/: looks different \(/, ': unexpected visual change (');
    if (input.failOnUnexpectedVisual) kind = 'regression';
  }

  // holdline's own analysis running out of time says nothing about the code: a note, not a change.
  const ownLimit = kind === 'change' && /analysis time budget \(\d+s\) exceeded/.test(title);

  return {
    probe: rep.probeId,
    probeTitle: rep.title,
    kind,
    severity: ownLimit ? 'info' : severityOf(rep.probeId, kind),
    scope: level.scope,
    reason: level.reason,
    title,
    ...(f.detail ? { detail: f.detail } : {}),
    ...(f.lines?.length ? { lines: f.lines } : {}),
    files: [...files].sort(),
    locations,
    meta,
  };
}
