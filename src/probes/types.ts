import type { Config } from '../core/config.js';
import type { RepoInfo } from '../core/git.js';
import type { Io } from '../io.js';

export interface ProbeContext {
  repo: RepoInfo;
  root: string;
  config: Config;
  /** The snapshot taken for this phase ("before" or "after"). */
  snapshotSha: string;
  phase: 'before' | 'after';
  /** Per-run directory under .holdline/runs/ for logs and artefacts. */
  runDir: string;
  io: Io;
}

export type FindingKind = 'regression' | 'fixed' | 'still-failing' | 'change' | 'info';

export interface Finding {
  kind: FindingKind;
  title: string;
  detail?: string;
  path?: string;
}

export interface ProbeReport {
  probeId: string;
  title: string;
  /** "regressed" makes `holdline after` exit non-zero. */
  status: 'ok' | 'changed' | 'regressed' | 'skipped';
  summary: string;
  findings: Finding[];
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
}
