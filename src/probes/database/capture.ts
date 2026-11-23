/** Captures the schema from the schema files and, when allowed, the live database. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../../core/config.js';
import { HOLDLINE_DIR } from '../../core/store.js';
import { writeCompactJson } from '../dependencies/store.js';
import { captureFiles, findSchemaFiles } from './files/index.js';
import { captureLive } from './live/index.js';
import { DB_SCHEMA_VERSION, dbSettings, type DbCapture, type DbRef, type DbSettings } from './types.js';

export function settingsFrom(config: Config | null): DbSettings {
  return dbSettings(config?.probes?.database as Record<string, unknown> | undefined);
}

export async function captureSchema(root: string, settings: DbSettings): Promise<DbCapture> {
  const found = await findSchemaFiles(root);
  const prismaDir = found.prisma.length ? path.dirname(found.prisma[0]!) : undefined;
  const [files, live] = await Promise.all([captureFiles(root, found), captureLive(root, settings, { prismaDir })]);
  return { version: DB_SCHEMA_VERSION, live, files };
}

// --- Storage (.holdline/db/schema-<phase>.json) --------------------------------------

export const dbCaptureFile = (root: string, phase: string) => path.join(root, HOLDLINE_DIR, 'db', `schema-${phase}.json`);
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export async function writeCapture(root: string, phase: string, capture: DbCapture): Promise<DbRef> {
  const file = dbCaptureFile(root, phase);
  const text = await writeCompactJson(file, capture);
  return {
    file: path.relative(root, file).split(path.sep).join('/'),
    sha256: sha256(text),
    live: capture.live.status,
    tables: Object.keys(capture.live.schema?.tables ?? capture.files.schema?.tables ?? {}).length,
  };
}

export async function readCapture(root: string, ref: DbRef | undefined): Promise<{ capture: DbCapture } | { error: string }> {
  if (!ref || typeof ref.file !== 'string') return { error: 'no schema reference recorded' };
  let text: string;
  try {
    text = await readFile(path.join(root, ref.file), 'utf8');
  } catch {
    return { error: `${ref.file} is missing` };
  }
  if (sha256(text) !== ref.sha256) return { error: `${ref.file} was changed or replaced since it was recorded` };
  try {
    const capture = JSON.parse(text) as DbCapture;
    if (capture.version !== DB_SCHEMA_VERSION) return { error: `${ref.file} was written by another holdline version` };
    return { capture };
  } catch {
    return { error: `${ref.file} is not valid JSON` };
  }
}

/** One-line description of where a capture's schema came from. */
export function describeCapture(c: DbCapture): string {
  const parts: string[] = [];
  const count = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (c.live.status === 'ok' && c.live.schema && c.live.target) {
    const t = c.live.target;
    parts.push(`${count(Object.keys(c.live.schema.tables).length, 'table')} from the live database (${t.dialect === 'sqlite' ? `SQLite ${t.host}` : `Postgres at ${t.host}:${t.port}`})`);
  }
  if (c.files.schema) {
    parts.push(`${count(Object.keys(c.files.schema.tables).length, 'table')} from ${c.files.sources.map((s) => s.label).join(', ')}`);
  }
  return parts.join('; ') || 'no schema files or database connection found';
}
