/** Decides whether to read the live database, and reads it safely if so. */
import path from 'node:path';
import type { DbSchema, DbSettings, LiveCapture } from '../types.js';
import { findConnectionString } from './env.js';
import { introspectPostgres, withReadOnlyPostgres } from './postgres.js';
import { safeError } from './redact.js';
import { introspectSqlite, openSqliteReadOnly } from './sqlite.js';
import { describeTarget, isLocalHost, parseConnectionString, safeTarget, type PgTarget, type SqliteTarget } from './target.js';

/**
 * The functions that actually open connections. Kept in an object so tests can verify
 * that no connection is attempted for a host that isn't allowed.
 */
export const connectors = {
  async postgres(target: PgTarget, settings: DbSettings): Promise<DbSchema> {
    return withReadOnlyPostgres(target, settings, (q) => introspectPostgres(q, settings.schemas));
  },
  async sqlite(target: SqliteTarget): Promise<DbSchema> {
    const h = await openSqliteReadOnly(target.file);
    try {
      return introspectSqlite(h);
    } finally {
      h.close();
    }
  },
};

export interface LiveOptions {
  /** Directory holding schema.prisma (Prisma resolves file: URLs against it). */
  prismaDir?: string;
}

export async function captureLive(root: string, settings: DbSettings, opts: LiveOptions = {}): Promise<LiveCapture> {
  if (!settings.connect) return { status: 'disabled', message: 'live database disabled (probes.database.connect is false)' };
  const found = await findConnectionString(root, settings.envVar);
  if (!found) return { status: 'none' };
  const where = `${found.envVar} in ${found.envFile}`;
  const parsed = parseConnectionString(found.value, { root, prismaDir: opts.prismaDir ? path.join(root, opts.prismaDir) : undefined });
  if (!parsed.ok) return { status: 'failed', message: `${where}: ${parsed.reason}; using schema files only` };

  const t = parsed.target;
  const local = t.dialect === 'sqlite' || isLocalHost(t.host);
  const allowed = local || (t.dialect === 'postgres' && settings.allowHosts.includes(t.host));
  const target = safeTarget(t, root, found.envVar, found.envFile, local);
  if (!allowed) {
    return {
      status: 'refused',
      target,
      message:
        `${where} points at a non-local host (${target.host}), so holdline did NOT connect to it and used schema files only. ` +
        `holdline only connects to local databases unless told otherwise; to allow this host, add "${target.host}" to ` +
        `probes.database.allowHosts in .holdline/config.json.`,
    };
  }

  const started = Date.now();
  try {
    const schema = t.dialect === 'postgres' ? await connectors.postgres(t, settings) : await connectors.sqlite(t);
    return { status: 'ok', target, schema, ms: Date.now() - started };
  } catch (e) {
    return {
      status: 'failed',
      target,
      message: `could not read the live database (${describeTarget(target)}, from ${where}): ${safeError(e, parsed.secrets)}. Using schema files only.`,
      ms: Date.now() - started,
    };
  }
}
