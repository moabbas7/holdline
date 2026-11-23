/**
 * Reusable baselines. When the working tree is exactly the state a previous run already
 * checked (the last `after`, or the background run at session start), a new `before` can
 * take those probe results instead of running the checks again.
 *
 * The candidate is .holdline/baseline/baseline.json. Probe data in it is whatever each
 * probe's saveBaseline() returned (inline results or a {file, sha256} reference to its own
 * capture file); restoreBaseline() turns it back into "before" data, verifying the file.
 * A probe whose data can't be restored is simply run again.
 */
import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from './config.js';
import { HOLDLINE_VERSION } from '../version.js';
import { readJson, storePaths, writeJson } from './store.js';

export const BASELINE_VERSION = 1;

export interface BaselineTree {
  tree: string;
  indexTree: string;
}

export interface BaselineCandidate {
  version: typeof BASELINE_VERSION;
  source: 'after' | 'warm';
  createdAt: string;
  holdlineVersion: string;
  configHash: string;
  /**
   * Working-tree states these results are valid for: the snapshot taken when the run
   * started, plus (for a run whose checks wrote files git doesn't ignore) the state after.
   */
  trees: BaselineTree[];
  /** The snapshot the run took (its commit). */
  snapshotSha: string;
  probes: Record<string, unknown>;
}

export const baselineFile = (root: string) => path.join(storePaths(root).dir, 'baseline', 'baseline.json');

/** Results are only reusable with the same configuration and holdline version. */
export async function configHash(root: string, config: Config): Promise<string> {
  let raw = '';
  try {
    raw = await readFile(storePaths(root).config, 'utf8');
  } catch {
    raw = JSON.stringify(config);
  }
  return createHash('sha256').update(`${HOLDLINE_VERSION}\0${raw}`).digest('hex').slice(0, 16);
}

export async function readCandidate(root: string): Promise<BaselineCandidate | null> {
  try {
    const c = await readJson<BaselineCandidate>(baselineFile(root));
    return c && c.version === BASELINE_VERSION && Array.isArray(c.trees) ? c : null;
  } catch {
    return null; // a corrupt candidate is just not reusable
  }
}

export async function saveCandidate(root: string, c: Omit<BaselineCandidate, 'version' | 'holdlineVersion' | 'createdAt'>): Promise<void> {
  await writeJson(baselineFile(root), { version: BASELINE_VERSION, holdlineVersion: HOLDLINE_VERSION, createdAt: new Date().toISOString(), ...c });
}

export async function clearCandidate(root: string): Promise<void> {
  await rm(baselineFile(root), { force: true });
}

/** The candidate, if it was recorded for exactly this working tree, staging area and config. */
export async function matchCandidate(root: string, state: BaselineTree, hash: string): Promise<BaselineCandidate | null> {
  const c = await readCandidate(root);
  if (!c || c.configHash !== hash) return null;
  return c.trees.some((t) => t.tree === state.tree && t.indexTree === state.indexTree) ? c : null;
}
