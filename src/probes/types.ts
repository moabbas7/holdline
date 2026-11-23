import type { Config } from '../core/config.js';
import type { RepoInfo } from '../core/git.js';
import type { Io } from '../io.js';
import type { DevServerPool } from './devServer.js';

export interface ProbeContext {
  repo: RepoInfo;
  root: string;
  config: Config;
  /** The snapshot taken for this phase ("before" or "after"). */
  snapshotSha: string;
  phase: 'before' | 'after';
  /**
   * Name used for the files this run writes (graph-<tag>.json, visual/<tag>/…). Defaults to
   * `phase`. The background baseline run (`holdline hook warm`) captures with phase "before"
   * but tag "warm", so it never overwrites the files an open session points at.
   */
  tag?: BaselineTag;
  /** Per-run directory under .holdline/runs/ for logs and artefacts. */
  runDir: string;
  io: Io;
  /**
   * Dev servers shared by the probes of one run (started at most once, killed when the run
   * ends). Optional: a probe without one starts and stops its own.
   */
  devServers?: DevServerPool;
  /**
   * after: files that holdline's own commands (the build in `before`) wrote after the
   * "before" snapshot. `excluded`: content in the "after" snapshot still matches what the
   * build wrote, so they are not agent changes. `edited`: the agent changed them since.
   */
  ownOutputs?: { excluded: Set<string>; edited: Set<string> };
}

export type BaselineTag = 'before' | 'after' | 'warm';
/** The file tag of a probe run. */
export const tagOf = (ctx: { phase: 'before' | 'after'; tag?: BaselineTag }): BaselineTag => ctx.tag ?? ctx.phase;

export type FindingKind = 'regression' | 'fixed' | 'still-failing' | 'change' | 'info';

/**
 * Structured facts about what a finding is about, used to classify it against the task's
 * scope and to build the HTML/JSON report. Purely descriptive: never changes detection.
 */
export interface FindingMeta {
  /** Files the finding is about (repo-relative, forward slashes). */
  files?: string[];
  /** Page URLs (as loaded, e.g. "/en/pricing"). */
  pages?: string[];
  /** API route patterns ("/api/users/:id"). */
  routes?: string[];
  /** Database tables (bare lower-case names). */
  tables?: string[];
  /** Files that consume the subject (callers of a route, users of a table, dependents). */
  affects?: string[];
  /** Source locations (callers, lines reading a removed field, …). */
  locations?: { file: string; line: number; text?: string }[];
  /** Screenshots for a visual difference (repo-relative paths). */
  images?: { before?: string; after?: string; diff?: string };
  viewports?: string[];
  /** A pixel difference (not an error) on a page. */
  visualDiff?: boolean;
  /** Set when the agent edited a file that holdline's own build had written in `before`. */
  ownOutputEdited?: boolean;
}

export interface Finding {
  kind: FindingKind;
  title: string;
  detail?: string;
  path?: string;
  /** Extra lines printed indented under the finding (e.g. what depends on a changed file). */
  lines?: string[];
  meta?: FindingMeta;
}

export interface ProbeReport {
  probeId: string;
  title: string;
  /** "regressed" makes `holdline after` exit non-zero. */
  status: 'ok' | 'changed' | 'regressed' | 'skipped';
  summary: string;
  findings: Finding[];
}

/** Context for Probe.rollbackWarnings (no snapshot is taken for a rollback). */
export interface RollbackContext {
  repo: RepoInfo;
  root: string;
  config: Config;
  io: Io;
}

/**
 * A probe captures one aspect of the project (check results, file list, and in later
 * phases dependency maps, DB schemas, API shapes, screenshots) and compares two captures.
 * snapshot() results must be JSON-serialisable: they are stored in .holdline/session.json.
 */
export interface Probe<S = unknown> {
  id: string;
  title: string;
  enabled(config: Config): boolean;
  snapshot(ctx: ProbeContext): Promise<S>;
  compare(before: S, after: S, ctx: ProbeContext): Promise<ProbeReport>;
  /**
   * Optional: lines to show before `holdline rollback` asks for confirmation, about state
   * a rollback does NOT restore (e.g. a live database). Receives this probe's "before" data.
   */
  rollbackWarnings?(before: S, ctx: RollbackContext): Promise<string[]>;
  /**
   * Optional: whether this capture can be reused as a later "before" baseline when the
   * working tree is unchanged (src/core/baseline.ts). Return the data to keep, or null when
   * it can't be reused. Probes without it are always re-run.
   */
  saveBaseline?(data: S, ctx: ProbeContext): Promise<unknown | null>;
  /**
   * Optional: turn kept data into this probe's "before" data for a new session (ctx is the
   * new "before" run: its snapshotSha and phase). Return null to re-run the probe instead.
   */
  restoreBaseline?(kept: unknown, ctx: ProbeContext): Promise<S | null>;
}
