/** Regex-based helpers for SQL text and Prisma schemas. */

const SQL_START = /^\s*(?:\(\s*)?(select|insert|update|delete|with)\b/i;

const NOT_TABLES = new Set([
  'select',
  'where',
  'set',
  'lateral',
  'unnest',
  'only',
  'values',
  'generate_series',
  'json_each',
  'jsonb_each',
  'jsonb_array_elements',
  'json_array_elements',
  'json_table',
  'dual',
  'information_schema',
  'the',
  'a',
  'an',
]);

const IDENT = `(?:"[^"]+"|\`[^\`]+\`|\\[[^\\]]+\\]|[A-Za-z_][\\w$]*)`;
const QUALIFIED = `(${IDENT}(?:\\s*\\.\\s*${IDENT})*)`;

/** Normalise a (possibly quoted, schema-qualified) table identifier: "public"."Users" → users. */
export function normaliseTable(raw: string): string | null {
  const parts = raw.split('.').map((p) => p.trim().replace(/^["`[]|["`\]]$/g, ''));
  const name = parts.at(-1)?.toLowerCase();
  if (!name || NOT_TABLES.has(name) || !/^[a-z_][\w$]*$/.test(name)) return null;
  return name;
}

/**
 * Does this string literal look like a SQL statement? It has to start with a DML keyword
 * and contain the clause that names a table, so ordinary UI text rarely matches.
 */
export function looksLikeSql(text: string): boolean {
  if (text.length < 10 || !SQL_START.test(text)) return false;
  return /\bfrom\s|\binto\s|^\s*update\s+\S+\s+set\b|\bjoin\s/i.test(text);
}

const DML_TABLE_RES = [
  new RegExp(`\\bfrom\\s+${QUALIFIED}`, 'gi'),
  new RegExp(`\\bjoin\\s+${QUALIFIED}`, 'gi'),
  new RegExp(`\\binto\\s+${QUALIFIED}`, 'gi'),
  new RegExp(`\\bupdate\\s+(?:only\\s+)?${QUALIFIED}\\s+set\\b`, 'gi'),
];

/** Table names referenced by a SQL statement. */
export function sqlTables(text: string): string[] {
  const cleaned = text
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    // FROM inside functions (EXTRACT(year FROM col), TRIM(x FROM y)) and IS DISTINCT FROM.
    .replace(/\b(?:extract|substring|substr|trim|overlay|position)\s*\([^()]*\)/gi, ' ')
    .replace(/\bdistinct\s+from\b/gi, ' ');
  // Names of CTEs (WITH x AS (...)) are not tables.
  const ctes = new Set<string>();
  for (const m of cleaned.matchAll(new RegExp(`(?:\\bwith(?:\\s+recursive)?|,)\\s*(${IDENT})\\s+as\\s*\\(`, 'gi'))) {
    const n = normaliseTable(m[1]!);
    if (n) ctes.add(n);
  }
  const out = new Set<string>();
  for (const re of DML_TABLE_RES) {
    for (const m of cleaned.matchAll(re)) {
      const n = normaliseTable(m[1]!);
      if (n && !ctes.has(n)) out.add(n);
    }
  }
  return [...out];
}

const DDL_RE = new RegExp(
  `\\b(?:create|alter|drop)\\s+(?:unlogged\\s+|temporary\\s+|temp\\s+)?table\\s+(?:if\\s+(?:not\\s+)?exists\\s+)?(?:only\\s+)?${QUALIFIED}`,
  'gi',
);

/** Tables created, altered or dropped by a .sql file. */
export function ddlTables(text: string): string[] {
  const cleaned = text.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
  const out = new Set<string>();
  for (const m of cleaned.matchAll(DDL_RE)) {
    const n = normaliseTable(m[1]!);
    if (n) out.add(n);
  }
  return [...out];
}

/** Prisma models in a schema file: model name → table name (honours @@map). */
export function prismaModels(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const cleaned = text.replace(/\/\/[^\n]*/g, '');
  for (const m of cleaned.matchAll(/\bmodel\s+(\w+)\s*\{([^}]*)\}/g)) {
    const map = /@@map\(\s*(?:name\s*:\s*)?"([^"]+)"/.exec(m[2]!);
    out[m[1]!] = (map ? map[1]! : m[1]!).toLowerCase();
  }
  return out;
}
