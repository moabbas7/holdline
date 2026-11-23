import { createHash, randomBytes } from 'node:crypto';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { HOLDLINE_DIR } from '../../core/store.js';
import type { DepGraph, DepGraphRef } from './types.js';

export function depsPaths(root: string) {
  const dir = path.join(root, HOLDLINE_DIR);
  return {
    holdlineDir: dir,
    cache: path.join(dir, 'cache', 'deps-v1.json'),
    graph: (phase: string) => path.join(dir, 'deps', `graph-${phase}.json`),
  };
}

export const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

/** Atomic write of compact JSON (temp file + rename). Returns the text written. */
export async function writeCompactJson(file: string, value: unknown): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  const text = JSON.stringify(value);
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, file);
  return text;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Save a graph to .holdline/deps/graph-<phase>.json and return the reference stored in the session. */
export async function writeGraph(root: string, phase: string, graph: DepGraph): Promise<DepGraphRef> {
  const file = depsPaths(root).graph(phase);
  const text = await writeCompactJson(file, graph);
  return { file: path.relative(root, file).split(path.sep).join('/'), sha256: sha256(text), stats: graph.stats };
}

export type ReadGraphResult = { graph: DepGraph } | { error: string };

/** Load the graph a reference points to, checking that it is the same file that was written. */
export async function readGraph(root: string, ref: DepGraphRef | undefined): Promise<ReadGraphResult> {
  if (!ref || typeof ref.file !== 'string') return { error: 'no graph reference recorded' };
  let text: string;
  try {
    text = await readFile(path.join(root, ref.file), 'utf8');
  } catch {
    return { error: `${ref.file} is missing` };
  }
  if (sha256(text) !== ref.sha256) return { error: `${ref.file} was changed or replaced since it was recorded` };
  try {
    return { graph: JSON.parse(text) as DepGraph };
  } catch {
    return { error: `${ref.file} is not valid JSON` };
  }
}
