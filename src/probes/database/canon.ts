/**
 * Canonical type names, so the same type spelled differently (int4 / integer / serial,
 * timestamptz / timestamp with time zone, a Prisma DateTime / timestamp(3)) compares equal.
 * Canonical forms follow Postgres's format_type() output, which is what a live database reports.
 */

const ALIASES: Record<string, string> = {
  int: 'integer',
  int4: 'integer',
  integer: 'integer',
  serial: 'integer',
  serial4: 'integer',
  int8: 'bigint',
  bigint: 'bigint',
  bigserial: 'bigint',
  serial8: 'bigint',
  int2: 'smallint',
  smallint: 'smallint',
  smallserial: 'smallint',
  serial2: 'smallint',
  float8: 'double precision',
  'double precision': 'double precision',
  float: 'double precision',
  float4: 'real',
  real: 'real',
  bool: 'boolean',
  boolean: 'boolean',
  varchar: 'character varying',
  'character varying': 'character varying',
  char: 'character',
  character: 'character',
  bpchar: 'character',
  decimal: 'numeric',
  numeric: 'numeric',
  timestamptz: 'timestamp with time zone',
  'timestamp with time zone': 'timestamp with time zone',
  timestamp: 'timestamp without time zone',
  'timestamp without time zone': 'timestamp without time zone',
  timetz: 'time with time zone',
  'time with time zone': 'time with time zone',
  time: 'time without time zone',
  'time without time zone': 'time without time zone',
  varbit: 'bit varying',
};

/** Types that imply an auto-increment default (and NOT NULL). */
export const SERIAL_TYPES = new Set(['serial', 'serial4', 'bigserial', 'serial8', 'smallserial', 'serial2']);

/**
 * Canonical Postgres type from a base name, optional modifiers and array dimensions.
 * `canonPg('timestamptz', [3])` → "timestamp(3) with time zone".
 */
export function canonPg(baseRaw: string, mods: (number | string)[] = [], arrayDims = 0): string {
  let base = baseRaw.trim().toLowerCase().replace(/\s+/g, ' ').replace(/^"|"$/g, '');
  base = base.replace(/^pg_catalog\./, '').replace(/^public\./, '');
  let dims = arrayDims;
  while (base.endsWith('[]')) {
    base = base.slice(0, -2).trim();
    dims++;
  }
  if (base.startsWith('_') && ALIASES[base.slice(1)]) {
    base = base.slice(1);
    dims++;
  }
  // Modifiers written inline: "varchar(10)", "timestamp(3) with time zone", "numeric(10, 2)".
  const inline = /^([a-z ]+?)\s*\(([^)]*)\)\s*(.*)$/.exec(base);
  if (inline) {
    base = `${inline[1]!.trim()}${inline[3] ? ' ' + inline[3].trim() : ''}`;
    mods = inline[2]!.split(',').map((m) => m.trim()).filter(Boolean);
  }
  const name = ALIASES[base] ?? base;
  const m = mods.length ? `(${mods.join(',')})` : '';
  let out: string;
  if (name.startsWith('timestamp ') || name.startsWith('time ')) {
    const [head, ...rest] = name.split(' ');
    out = `${head}${m} ${rest.join(' ')}`;
  } else if (name === 'character' && !m) {
    // char without a length is char(1).
    out = baseRaw.toLowerCase() === 'bpchar' ? 'character' : 'character(1)';
  } else {
    out = name + m;
  }
  return out + '[]'.repeat(dims);
}

/** SQLite declared types are free text: just normalise case and spacing. */
export function canonSqlite(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ').replace(/\s*\(\s*/g, '(').replace(/\s*,\s*/g, ',').replace(/\s*\)/g, ')');
}

/** Normalise SQL expression text for display and loose comparison (case outside quotes, whitespace, casts). */
export function normaliseExpr(text: string): string {
  let out = '';
  let quote: string | null = null;
  for (const ch of text) {
    if (quote) {
      out += ch;
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
    } else {
      out += ch.toLowerCase();
    }
  }
  return out.replace(/\s+/g, ' ').trim();
}

const PRISMA_PG: Record<string, string> = {
  String: 'text',
  Int: 'integer',
  BigInt: 'bigint',
  Float: 'double precision',
  Decimal: 'numeric(65,30)',
  Boolean: 'boolean',
  DateTime: 'timestamp(3) without time zone',
  Json: 'jsonb',
  Bytes: 'bytea',
};

const PRISMA_SQLITE: Record<string, string> = {
  String: 'text',
  Int: 'integer',
  BigInt: 'bigint',
  Float: 'real',
  Decimal: 'decimal',
  Boolean: 'boolean',
  DateTime: 'datetime',
  Json: 'jsonb',
  Bytes: 'blob',
};

const PRISMA_NATIVE: Record<string, string> = {
  Text: 'text',
  VarChar: 'varchar',
  Char: 'char',
  Uuid: 'uuid',
  Integer: 'integer',
  Int: 'integer',
  SmallInt: 'smallint',
  BigInt: 'bigint',
  Real: 'real',
  DoublePrecision: 'double precision',
  Decimal: 'numeric',
  Money: 'money',
  Boolean: 'boolean',
  Timestamp: 'timestamp',
  Timestamptz: 'timestamptz',
  Date: 'date',
  Time: 'time',
  Timetz: 'timetz',
  Json: 'json',
  JsonB: 'jsonb',
  ByteA: 'bytea',
  Inet: 'inet',
  Citext: 'citext',
  Xml: 'xml',
  Bit: 'bit',
  VarBit: 'varbit',
  Oid: 'oid',
};

/**
 * Database type for a Prisma field: `prismaType('DateTime', '@db.Timestamptz(6)')`.
 * Enum and unknown types pass through as their (lower-cased) name.
 */
export function prismaType(type: string, native: string | null, provider: string, isList: boolean): string {
  const sqlite = provider === 'sqlite';
  let out: string;
  if (native && !sqlite) {
    const m = /^@db\.(\w+)(?:\(([^)]*)\))?$/.exec(native);
    const base = m ? (PRISMA_NATIVE[m[1]!] ?? m[1]!.toLowerCase()) : 'text';
    const mods = m?.[2] ? m[2].split(',').map((s) => s.trim()).filter(Boolean) : [];
    out = canonPg(base, mods);
  } else if (sqlite) {
    out = PRISMA_SQLITE[type] ?? type.toLowerCase();
  } else {
    out = PRISMA_PG[type] ?? canonPg(type);
  }
  return isList ? `${out}[]` : out;
}
