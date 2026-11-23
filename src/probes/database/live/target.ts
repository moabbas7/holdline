/**
 * Turns a connection string into an explicit connection target and decides whether holdline
 * may connect to it. Only local hosts are allowed by default: .env files often hold
 * production URLs, and holdline must never touch production unless told to.
 */
import { isIP } from 'node:net';
import path from 'node:path';
import type { Dialect, SafeTarget } from '../types.js';

export interface PgTarget {
  dialect: 'postgres';
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl: false | { rejectUnauthorized: boolean };
}

export interface SqliteTarget {
  dialect: 'sqlite';
  /** Absolute path. */
  file: string;
}

export type ConnectionTarget = PgTarget | SqliteTarget;

export type ParseResult =
  | { ok: true; target: ConnectionTarget; secrets: string[] }
  | { ok: false; reason: string; secrets: string[] };

const SAFE_DECODE = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/**
 * Parse a postgres:// or SQLite (file:, sqlite:) connection string. Anything that could make
 * the driver connect somewhere other than the parsed host (several hosts, a `host=` parameter,
 * a socket directory) is rejected. `secrets` lists every substring that must never be printed.
 */
export function parseConnectionString(raw: string, opts: { root: string; prismaDir?: string }): ParseResult {
  const value = raw.trim();
  const secrets = [value];
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase();

  if (scheme === 'file' || scheme === 'sqlite' || scheme === 'sqlite3') {
    let p = value.replace(/^[a-z0-9]+:(\/\/)?/i, '').split('?')[0]!;
    // file:///C:/db.sqlite → C:/db.sqlite (not /C:/…, which resolves to C:\C:\… on Windows).
    if (/^\/[A-Za-z]:[\\/]/.test(p)) p = p.slice(1);
    if (p === ':memory:' || p === '') return { ok: false, reason: 'an in-memory SQLite database has no schema to read', secrets };
    // Prisma resolves relative SQLite paths against the schema.prisma folder.
    const base = scheme === 'file' && opts.prismaDir ? opts.prismaDir : opts.root;
    p = path.resolve(base, SAFE_DECODE(p));
    return { ok: true, target: { dialect: 'sqlite', file: p }, secrets };
  }
  if (scheme !== 'postgres' && scheme !== 'postgresql') {
    return { ok: false, reason: `unsupported connection string type${scheme ? ` "${scheme}:"` : ''} (holdline reads Postgres and SQLite)`, secrets };
  }

  const m = /^[a-z]+:\/\/(?:([^:@/?#]*)(?::([^@/?#]*))?@)?([^/?#]*)(?:\/([^?#]*))?(?:\?([^#]*))?/i.exec(value);
  if (!m) return { ok: false, reason: 'the connection string could not be parsed', secrets };
  const [, userRaw = '', passRaw = '', hostPort = '', dbRaw = '', query = ''] = m;
  const user = SAFE_DECODE(userRaw);
  const password = SAFE_DECODE(passRaw);
  for (const s of [userRaw, passRaw, user, password]) if (s && s.length >= 3) secrets.push(s);
  if (hostPort.includes(',')) return { ok: false, reason: 'connection strings with several hosts are not supported', secrets };

  const params = new URLSearchParams(query);
  for (const p of ['host', 'hostaddr', 'service']) {
    if (params.has(p)) return { ok: false, reason: `the "${p}" parameter is not supported (holdline only connects to the host in the URL)`, secrets };
  }
  for (const p of ['password', 'user', 'passfile', 'sslpassword', 'sslkey']) {
    const v = params.get(p);
    if (v && v.length >= 3) secrets.push(v);
  }

  let host: string;
  let portStr: string | undefined;
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(hostPort);
  if (v6) [host, portStr] = [v6[1]!, v6[2]];
  else [host, portStr] = hostPort.split(':') as [string, string | undefined];
  host = SAFE_DECODE(host).toLowerCase();
  if (!host || host.startsWith('/')) return { ok: false, reason: 'connecting through a Unix socket is not supported; use a TCP host', secrets };
  const port = portStr ? Number(portStr) : 5432;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return { ok: false, reason: 'the port is not valid', secrets };

  const sslmode = params.get('sslmode')?.toLowerCase();
  const local = isLocalHost(host);
  let ssl: PgTarget['ssl'];
  if (sslmode === 'disable' || (local && !sslmode) || (local && sslmode === 'prefer') || (local && sslmode === 'allow')) ssl = false;
  else if (sslmode === 'verify-ca' || sslmode === 'verify-full') ssl = { rejectUnauthorized: true };
  else ssl = { rejectUnauthorized: false };

  return {
    ok: true,
    target: { dialect: 'postgres', host, port, user: user || 'postgres', password, database: SAFE_DECODE(dbRaw) || user || 'postgres', ssl },
    secrets,
  };
}

/**
 * Hosts holdline connects to without being asked: loopback, `*.localhost`, Docker's host
 * alias and single-label names such as Docker Compose service names (`db`, `postgres`,
 * `supabase_db_myapp`). Private network ranges are NOT treated as local: they can be a
 * production database inside a VPC.
 */
export function isLocalHost(hostRaw: string): boolean {
  const host = hostRaw.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === 'host.docker.internal' || host === 'gateway.docker.internal') return true;
  const ipv = isIP(host);
  if (ipv === 4) return host.startsWith('127.') || host === '0.0.0.0';
  if (ipv === 6) return host === '::1' || host === '0:0:0:0:0:0:0:1' || host === '::ffff:127.0.0.1';
  // A single DNS label (no dots): a Docker / Compose service name.
  return /^[a-z0-9]([a-z0-9_-]*[a-z0-9])?$/.test(host);
}

/** Description of a target that is safe to print and store. */
export function safeTarget(t: ConnectionTarget, root: string, envVar: string, envFile: string, local: boolean): SafeTarget {
  if (t.dialect === 'sqlite') {
    const rel = path.relative(root, t.file).split(path.sep).join('/');
    return { dialect: 'sqlite', host: rel.startsWith('..') ? path.basename(t.file) : rel, local: true, envVar, envFile };
  }
  return { dialect: 'postgres' as Dialect, host: t.host, port: t.port, local, envVar, envFile } as SafeTarget;
}

export function describeTarget(t: SafeTarget): string {
  return t.dialect === 'sqlite' ? `SQLite ${t.host}` : `Postgres at ${t.host}:${t.port}`;
}
