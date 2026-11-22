import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { extractPrisma, extractSource, extractSql } from './extract.js';
import { MAX_FILE_BYTES, type FileKind } from './files.js';
import { depsPaths, exists, writeCompactJson } from './store.js';
import { EXTRACTOR_VERSION, emptyFacts, type FileFacts } from './types.js';

interface CacheFile {
  version: number;
  entries: Record<string, FileFacts>;
}

export interface LoadedFacts {
  facts: Map<string, FileFacts>;
  /** Content hash per file (first 20 hex chars of sha256). */
  hashes: Map<string, string>;
  parsed: number;
  cached: number;
}

/** Run `fn` over `items` with at most `limit` in flight. */
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

const extOf = (p: string) => path.posix.extname(p);

/**
 * Read every analysed file, hash it, and return its facts: from the cache when the content
 * (and extension) was seen before, otherwise by parsing it. The cache lives in
 * .holdline/cache/ and is only written when .holdline/ already exists.
 */
export async function loadFacts(
  root: string,
  analysed: Map<string, FileKind>,
  opts: { extractorVersion?: number } = {},
): Promise<LoadedFacts> {
  const version = opts.extractorVersion ?? EXTRACTOR_VERSION;
  const paths = depsPaths(root);
  let cache: CacheFile = { version, entries: {} };
  try {
    const parsed = JSON.parse(await readFile(paths.cache, 'utf8')) as CacheFile;
    if (parsed && parsed.version === version && parsed.entries) cache = parsed;
  } catch {
    /* no cache yet, or unreadable: start fresh */
  }

  const texts = new Map<string, string>();
  const keys = new Map<string, string>();
  const hashes = new Map<string, string>();
  await mapLimit([...analysed.keys()], 64, async (rel) => {
    let buf: Buffer;
    try {
      buf = await readFile(path.join(root, rel));
    } catch {
      return; // deleted or unreadable since listing
    }
    if (buf.length > MAX_FILE_BYTES) return;
    const hash = createHash('sha256').update(buf).digest('hex');
    hashes.set(rel, hash.slice(0, 20));
    keys.set(rel, `${extOf(rel)}:${hash}`);
    if (!cache.entries[`${extOf(rel)}:${hash}`]) texts.set(rel, buf.toString('utf8'));
  });

  const facts = new Map<string, FileFacts>();
  const used: Record<string, FileFacts> = {};
  let parsed = 0;
  let cached = 0;
  const misses: string[] = [];
  // Deterministic order (reads finish in any order), so graphs are stable across runs.
  for (const rel of [...keys.keys()].sort()) {
    const key = keys.get(rel)!;
    const hit = cache.entries[key];
    if (hit) {
      facts.set(rel, hit);
      used[key] = hit;
      cached++;
    } else {
      misses.push(rel);
    }
  }

  if (misses.length > 0) {
    const sourceMisses = misses.filter((m) => analysed.get(m) === 'source');
    const parser = sourceMisses.length > 0 ? await makeParser() : null;
    for (const rel of misses) {
      const text = texts.get(rel)!;
      texts.delete(rel);
      const kind = analysed.get(rel)!;
      let f: FileFacts;
      let ok = true;
      try {
        f = kind === 'sql' ? extractSql(text) : kind === 'prisma' ? extractPrisma(text) : parser!(rel, text);
      } catch {
        f = emptyFacts();
        ok = false;
      }
      facts.set(rel, f);
      parsed++;
      if (ok) used[keys.get(rel)!] = f;
    }
  }

  const dropped = Object.keys(cache.entries).some((k) => !(k in used));
  if ((parsed > 0 || dropped) && (await exists(paths.holdlineDir))) {
    await writeCompactJson(paths.cache, { version, entries: used } satisfies CacheFile);
  }
  const sorted = new Map([...facts].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));
  return { facts: sorted, hashes, parsed, cached };
}

async function makeParser(): Promise<(rel: string, text: string) => FileFacts> {
  const tsm = await import('ts-morph');
  const { Project, ts } = tsm;
  const project = new Project({
    useInMemoryFileSystem: true,
    skipLoadingLibFiles: true,
    skipFileDependencyResolution: true,
    compilerOptions: { allowJs: true, jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ESNext },
  });
  const kindFor = (rel: string) => {
    const ext = extOf(rel);
    if (ext === '.tsx') return ts.ScriptKind.TSX;
    if (ext === '.jsx') return ts.ScriptKind.JSX;
    if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return ts.ScriptKind.JS;
    return ts.ScriptKind.TS;
  };
  return (rel, text) => {
    const sf = project.createSourceFile(`/${rel}`, text, { overwrite: true, scriptKind: kindFor(rel) });
    try {
      return extractSource(sf, tsm);
    } finally {
      project.removeSourceFile(sf);
    }
  };
}
