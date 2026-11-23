/** Bumped whenever the stored schema format changes. */
export const DB_SCHEMA_VERSION = 1;

export type Dialect = 'postgres' | 'sqlite' | 'mysql';

export interface Column {
  name: string;
  /** Canonical type (see canon.ts), e.g. "integer", "character varying(10)", "text[]". */
  type: string;
  nullable: boolean;
  /** Default expression for display, or null. */
  default: string | null;
  /** Comparable form of the default (only meaningful between captures from the same kind of source). */
  defaultKey?: string;
  identity?: boolean;
  generated?: boolean;
  /** Name used in code when it differs from the column name (Prisma field, Drizzle key). */
  field?: string;
}

export interface ForeignKey {
  name: string;
  columns: string[];
  /** Table key of the referenced table ("public.users"). */
  refTable: string;
  refColumns: string[];
  onDelete?: string;
}

export interface Index {
  name: string;
  columns: string[];
  unique: boolean;
  where?: string;
}

export interface UniqueConstraint {
  name: string;
  columns: string[];
}

export interface Policy {
  name: string;
  /** all | select | insert | update | delete */
  command: string;
  roles: string[];
  permissive: boolean;
  using: string | null;
  check: string | null;
  /** Comparable forms of using/check. */
  usingKey?: string | null;
  checkKey?: string | null;
}

export interface Table {
  schema: string;
  name: string;
  columns: Record<string, Column>;
  primaryKey: string[];
  primaryKeyName?: string;
  foreignKeys: ForeignKey[];
  uniques: UniqueConstraint[];
  indexes: Index[];
  /** Row-level security; null when the source can't express it (SQLite, Prisma). */
  rls: boolean | null;
  policies: Record<string, Policy>;
  /** File that defines the table (files source only). */
  definedIn?: string;
  /** Drizzle consts bound to the table (`users` in `users.email`). */
  codeNames?: string[];
  /** Prisma client accessor (`user` in `prisma.user.findMany`). */
  prismaAccessor?: string;
}

export interface Rename {
  kind: 'table' | 'column';
  /** Table key (for a table rename: the old key). */
  table: string;
  from: string;
  to: string;
  file?: string;
}

export interface DbSchema {
  dialect: Dialect;
  /** Keyed by "schema.table". */
  tables: Record<string, Table>;
  /** Keyed by "schema.type" → ordered values. */
  enums: Record<string, string[]>;
  /** Keyed by "schema.view". */
  views: Record<string, { materialized: boolean; definedIn?: string }>;
  /** Explicit renames seen in migrations, in order. */
  renames: Rename[];
}

export function emptySchema(dialect: Dialect = 'postgres'): DbSchema {
  return { dialect, tables: {}, enums: {}, views: {}, renames: [] };
}

export function emptyTable(schema: string, name: string): Table {
  return { schema, name, columns: {}, primaryKey: [], foreignKeys: [], uniques: [], indexes: [], rls: null, policies: {} };
}

export const defaultSchemaName = (d: Dialect) => (d === 'sqlite' ? 'main' : 'public');

/** "public.users" → "users"; "billing.invoices" stays. */
export function displayName(key: string): string {
  return key.startsWith('public.') ? key.slice(7) : key.startsWith('main.') ? key.slice(5) : key;
}

/** Bare, lower-case table name, as used for `table:<name>` nodes in the dependency graph. */
export function bareName(key: string): string {
  return key.slice(key.indexOf('.') + 1).toLowerCase();
}

/** Where a schema came from, without any secret. */
export interface SafeTarget {
  dialect: Dialect;
  /** Host name only (no user, password, port or parameters); for SQLite the file path relative to the project. */
  host: string;
  port?: number;
  local: boolean;
  /** Env variable and file the connection string was read from. */
  envVar: string;
  envFile: string;
}

export type LiveStatus = 'ok' | 'none' | 'disabled' | 'refused' | 'failed';

export interface LiveCapture {
  status: LiveStatus;
  target?: SafeTarget;
  schema?: DbSchema;
  /** Human-readable explanation, already free of secrets. */
  message?: string;
  ms?: number;
}

export interface FilesCapture {
  schema: DbSchema | null;
  /** Schema files read, grouped for display: "supabase/migrations (12 files)". */
  sources: { kind: 'sql' | 'prisma' | 'drizzle'; label: string; files: string[] }[];
  warnings: string[];
  ms: number;
}

export interface DbCapture {
  version: number;
  live: LiveCapture;
  files: FilesCapture;
}

/** What the probe keeps in session.json: a pointer to the capture file. */
export interface DbRef {
  file: string;
  sha256: string;
  live: LiveStatus;
  tables: number;
}

/** Settings from config.probes.database. */
export interface DbSettings {
  enabled: boolean;
  /** Extra env variable name to read the connection string from (checked first). */
  envVar?: string;
  /** Non-local hosts holdline may connect to. */
  allowHosts: string[];
  /** Postgres schemas to read (default: all user schemas except Supabase internals). */
  schemas?: string[];
  /** false: never connect, use schema files only. */
  connect: boolean;
  statementTimeoutMs: number;
  connectTimeoutMs: number;
}

export function dbSettings(raw: Record<string, unknown> | undefined): DbSettings {
  const r = raw ?? {};
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const num = (v: unknown, d: number) => (typeof v === 'number' && v > 0 ? v : d);
  return {
    enabled: r.enabled !== false,
    envVar: typeof r.envVar === 'string' && r.envVar ? r.envVar : undefined,
    allowHosts: strings(r.allowHosts).map((h) => h.toLowerCase()),
    schemas: Array.isArray(r.schemas) ? strings(r.schemas) : undefined,
    connect: r.connect !== false,
    statementTimeoutMs: num(r.statementTimeoutMs, 5000),
    connectTimeoutMs: num(r.connectTimeoutMs, 3000),
  };
}
