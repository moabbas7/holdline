/**
 * The task's scope: which files, routes, pages and tables the task text names, plus
 * `--scope` globs. Computed in `holdline before` from the "before" state and stored in the
 * session, so `after` can explain every classification.
 */
import path from 'node:path';
import { git, splitNul, type RepoInfo } from '../core/git.js';
import { HOLDLINE_DIR } from '../core/store.js';
import { matchRoute, nextPagePattern } from '../probes/dependencies/routes.js';
import type { DepGraph } from '../probes/dependencies/types.js';
import { extractTerms, isGenericWord, norm, subwords, type TermKind } from './terms.js';

export interface ScopeTerm {
  text: string;
  kind: TermKind;
  /** Normalised words (lower-case, singular) for name/phrase/word terms. */
  words: string[];
  files: string[];
  routes: string[];
  tables: string[];
  /** Migration / schema files that define the matched tables. */
  tableFiles: string[];
  /** Set when the term was ignored (e.g. it matches too much of the project to mean anything). */
  dropped?: string;
}

export interface TaskScope {
  version: 1;
  task: string;
  globs: string[];
  terms: ScopeTerm[];
  /** Files in the project when the scope was computed. */
  totalFiles: number;
}

export interface ProjectView {
  /** Every non-ignored file (repo-relative, forward slashes). */
  files: string[];
  graph: DepGraph | null;
}

/** A word that matches more files than this is too generic to define the task's area. */
export const wordLimit = (totalFiles: number) => Math.max(12, Math.ceil(totalFiles * 0.02));

/** Lower-case, singular sub-words of each path segment (extension dropped from the file name). */
export function segmentWords(file: string): string[][] {
  const segs = file.split('/');
  const last = segs.length - 1;
  return segs.map((s, i) => subwords(i === last ? s.replace(/\.[^.]+$/, '') : s).map(norm));
}

const containsRun = (hay: string[], needle: string[]) => {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
};

export const toPattern = (route: string) => route.replace(/\[\[?\.\.\.[^\]]+\]?\]/g, '*').replace(/\[([^\]]+)\]/g, ':$1');

/** Files of the project as recorded in a snapshot. */
export async function snapshotFiles(repo: RepoInfo, sha: string): Promise<string[]> {
  const out = await git(['ls-tree', '-r', '-z', '--name-only', '--full-tree', sha], { cwd: repo.root });
  return splitNul(out).filter((f) => f !== HOLDLINE_DIR && !f.startsWith(`${HOLDLINE_DIR}/`));
}

/** Page files (Next.js app/pages routers) with their URL pattern. */
export function pageFiles(files: string[]): { file: string; pattern: string }[] {
  const out: { file: string; pattern: string }[] = [];
  for (const f of files) {
    if (!/\.(?:[cm]?[jt]sx?|mdx)$/.test(f)) continue;
    const pattern = nextPagePattern(f);
    if (pattern) out.push({ file: f, pattern });
  }
  return out;
}

export function matchTask(task: string, globs: string[], project: ProjectView): TaskScope {
  const { files, graph } = project;
  const limit = wordLimit(files.length);
  const words = new Map(files.map((f) => [f, segmentWords(f)]));
  const tables = Object.keys(graph?.tables ?? {});
  const tableWords = new Map(tables.map((t) => [t, subwords(t).map(norm)]));
  const pages = pageFiles(files);
  const terms: ScopeTerm[] = [];

  for (const t of extractTerms(task)) {
    const st: ScopeTerm = { text: t.text, kind: t.kind, words: t.words, files: [], routes: [], tables: [], tableFiles: [] };
    switch (t.kind) {
      case 'path': {
        const p = t.text.replace(/\\/g, '/');
        st.files = files.filter((f) => f === p || f.endsWith(`/${p}`) || f.startsWith(`${p}/`) || f.includes(`/${p}/`));
        break;
      }
      case 'route': {
        const r = toPattern(t.text);
        st.routes = Object.keys(graph?.routes ?? {}).filter((pat) => matchRoute(r, pat) >= 0);
        const routeFiles = st.routes.flatMap((pat) => graph!.routes[pat]!.files);
        const pageHits = pages.filter((p) => matchRoute(r, p.pattern) >= 0).map((p) => p.file);
        st.files = [...new Set([...routeFiles, ...pageHits])];
        break;
      }
      case 'name': {
        st.files = files.filter((f) => {
          const sw = words.get(f)!;
          return sw.some((seg) => seg.length === t.words.length && containsRun(seg, t.words));
        });
        st.tables = tables.filter((tb) => tableWords.get(tb)!.join(' ') === t.words.join(' '));
        break;
      }
      case 'phrase': {
        if (t.words.every((w) => isGenericWord(w))) continue;
        st.files = files.filter((f) => words.get(f)!.some((seg) => containsRun(seg, t.words)));
        st.tables = tables.filter((tb) => tableWords.get(tb)!.join(' ') === t.words.join(' '));
        if (st.files.length > limit) st.dropped = `matches ${st.files.length} files`;
        break;
      }
      case 'word': {
        const w = t.words[0]!;
        st.files = files.filter((f) => words.get(f)!.some((seg) => seg.includes(w)));
        st.tables = tables.filter((tb) => {
          const tw = tableWords.get(tb)!;
          return tw.length === 1 && tw[0] === w;
        });
        if (st.files.length > limit) st.dropped = `matches ${st.files.length} files, too many to say where the task is`;
        break;
      }
    }
    st.tableFiles = [...new Set(st.tables.flatMap((tb) => graph?.tables[tb]?.definedIn ?? []))].sort();
    st.files.sort();
    terms.push(st);
  }
  return { version: 1, task, globs: [...globs], terms, totalFiles: files.length };
}

/** Does a file match a --scope glob? A glob without wildcards also matches a folder prefix. */
export function matchesScopeGlob(file: string, glob: string): boolean {
  const g = glob.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!/[*?[\]{}]/.test(g)) return file === g || file.startsWith(`${g}/`);
  return path.posix.matchesGlob(file, g);
}

/** Does a file path match a name, phrase or word term (the same rules as matchTask)? */
export function termMatchesFile(t: ScopeTerm, file: string): boolean {
  const segs = segmentWords(file);
  switch (t.kind) {
    case 'path': {
      const p = t.text.replace(/\\/g, '/');
      return file === p || file.endsWith(`/${p}`) || file.startsWith(`${p}/`) || file.includes(`/${p}/`);
    }
    case 'name':
      return segs.some((seg) => seg.length === t.words.length && containsRun(seg, t.words));
    case 'phrase':
      return !t.words.every((w) => isGenericWord(w)) && segs.some((seg) => containsRun(seg, t.words));
    case 'word':
      return segs.some((seg) => seg.includes(t.words[0]!));
    default:
      return false;
  }
}
