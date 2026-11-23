/** Reads Prisma schema files (models, fields, relations, indexes, enums) into the schema model, using database names. */
import { prismaType } from '../canon.js';
import { emptyTable, type Column, type DbSchema, type Table } from '../types.js';

const SCALARS = new Set(['String', 'Int', 'BigInt', 'Float', 'Decimal', 'Boolean', 'DateTime', 'Json', 'Bytes']);

/** Strip // comments (not inside strings). */
function stripComments(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      let q = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"' && line[i - 1] !== '\\') q = !q;
        else if (!q && c === '/' && line[i + 1] === '/') return line.slice(0, i);
      }
      return line;
    })
    .join('\n');
}

/** Blocks like `model X { … }`, `enum Y { … }`, `datasource db { … }`. Braces inside attributes are balanced. */
function blocks(text: string): { kind: string; name: string; body: string }[] {
  const out: { kind: string; name: string; body: string }[] = [];
  const re = /\b(model|enum|view|datasource|type)\s+(\w+)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < text.length && depth > 0) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') depth--;
      i++;
    }
    out.push({ kind: m[1]!, name: m[2]!, body: text.slice(re.lastIndex, i - 1) });
    re.lastIndex = i;
  }
  return out;
}

/** Arguments of `@attr(...)` with balanced parentheses, or null if absent. */
function attrArgs(line: string, attr: string): string | null {
  const re = new RegExp(`${attr.replace(/[.@]/g, (c) => `\\${c}`)}(?![\\w.])`);
  const m = re.exec(line);
  if (!m) return null;
  let i = m.index + m[0].length;
  if (line[i] !== '(') return '';
  let depth = 0;
  const start = i + 1;
  for (; i < line.length; i++) {
    if (line[i] === '(') depth++;
    else if (line[i] === ')' && --depth === 0) return line.slice(start, i);
  }
  return line.slice(start);
}

const listOf = (s: string | null | undefined): string[] =>
  s ? (/\[([^\]]*)\]/.exec(s)?.[1] ?? '').split(',').map((x) => x.trim().replace(/\(.*$/, '')).filter(Boolean) : [];
const namedArg = (s: string | null, name: string): string | undefined =>
  s ? (new RegExp(`\\b${name}\\s*:\\s*"([^"]+)"`).exec(s)?.[1]) : undefined;
const quoted = (s: string | null): string | undefined => (s ? /^\s*"([^"]+)"/.exec(s)?.[1] : undefined);

interface RawField {
  name: string;
  type: string;
  optional: boolean;
  list: boolean;
  line: string;
}

/** Apply Prisma schema files (all files of a multi-file schema together) to `schema`. */
export function applyPrisma(schema: DbSchema, files: { path: string; text: string }[]): { provider: string } {
  const all = files.map((f) => ({ path: f.path, blocks: blocks(stripComments(f.text)) }));
  let provider = 'postgresql';
  for (const f of all) {
    for (const b of f.blocks) if (b.kind === 'datasource') provider = /provider\s*=\s*"(\w+)"/.exec(b.body)?.[1] ?? provider;
  }
  const defSchema = provider === 'sqlite' ? 'main' : 'public';
  const enums = new Map<string, string[]>();
  for (const f of all) {
    for (const b of f.blocks.filter((x) => x.kind === 'enum')) {
      const vals: string[] = [];
      let enumName = b.name;
      for (const line of b.body.split('\n').map((l) => l.trim()).filter(Boolean)) {
        if (line.startsWith('@@map')) enumName = quoted(attrArgs(line, '@@map')) ?? enumName;
        else if (!line.startsWith('@@')) vals.push(quoted(attrArgs(line, '@map')) ?? line.split(/\s/)[0]!);
      }
      enums.set(b.name, vals);
      if (provider !== 'sqlite') schema.enums[`${defSchema}.${enumName}`] = vals;
    }
  }

  // First pass: model → table key and field → column name, for relations.
  const models = new Map<string, { key: string; table: Table; fields: RawField[]; body: string; file: string }>();
  for (const f of all) {
    for (const b of f.blocks.filter((x) => x.kind === 'model' || x.kind === 'view')) {
      const lines = b.body.split('\n').map((l) => l.trim()).filter(Boolean);
      const map = lines.find((l) => l.startsWith('@@map'));
      const sch = lines.find((l) => l.startsWith('@@schema'));
      const tableName = (map && quoted(attrArgs(map, '@@map'))) ?? b.name;
      const tableSchema = (sch && quoted(attrArgs(sch, '@@schema'))) ?? defSchema;
      if (b.kind === 'view') {
        schema.views[`${tableSchema}.${tableName}`] = { materialized: false, definedIn: f.path };
        continue;
      }
      const fields: RawField[] = [];
      for (const line of lines) {
        if (line.startsWith('@@')) continue;
        const m = /^(\w+)\s+(\w+(?:\.\w+)?(?:\([^)]*\))?)(\[\])?(\?)?/.exec(line);
        if (!m) continue;
        fields.push({ name: m[1]!, type: m[2]!, list: Boolean(m[3]), optional: Boolean(m[4]), line });
      }
      const table = emptyTable(tableSchema, tableName);
      table.definedIn = f.path;
      table.prismaAccessor = b.name[0]!.toLowerCase() + b.name.slice(1);
      models.set(b.name, { key: `${tableSchema}.${tableName}`, table, fields, body: b.body, file: f.path });
    }
  }
  const colName = (model: string, field: string): string => {
    const f = models.get(model)?.fields.find((x) => x.name === field);
    return (f && quoted(attrArgs(f.line, '@map'))) ?? field;
  };

  for (const [modelName, m] of models) {
    const t = m.table;
    for (const f of m.fields) {
      const isScalar = SCALARS.has(f.type) || f.type.startsWith('Unsupported');
      const isEnum = enums.has(f.type);
      if (!isScalar && !isEnum) {
        // Relation field: the foreign key lives on the side with fields/references.
        const rel = attrArgs(f.line, '@relation');
        const fields = listOf(rel && /fields\s*:\s*(\[[^\]]*\])/.exec(rel)?.[1]);
        const refs = listOf(rel && /references\s*:\s*(\[[^\]]*\])/.exec(rel)?.[1]);
        const target = models.get(f.type);
        if (fields.length && target) {
          const cols = fields.map((x) => colName(modelName, x));
          const onDelete = rel ? /onDelete\s*:\s*(\w+)/.exec(rel)?.[1] : undefined;
          t.foreignKeys.push({
            name: namedArg(rel, 'map') ?? `${t.name}_${cols.join('_')}_fkey`,
            columns: cols,
            refTable: target.key,
            refColumns: refs.map((x) => colName(f.type, x)),
            ...(onDelete ? { onDelete: onDelete.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase() } : {}),
          });
        }
        continue;
      }
      const name = quoted(attrArgs(f.line, '@map')) ?? f.name;
      const native = /@db\.\w+(?:\([^)]*\))?/.exec(f.line)?.[0] ?? null;
      let type: string;
      if (f.type.startsWith('Unsupported')) type = (/Unsupported\("([^"]+)"\)/.exec(f.type)?.[1] ?? 'unknown').toLowerCase();
      else if (isEnum) type = provider === 'sqlite' ? 'text' : f.type.toLowerCase() + (f.list ? '[]' : '');
      else type = prismaType(f.type, native, provider, f.list);
      const def = attrArgs(f.line, '@default');
      const col: Column = {
        name,
        type,
        nullable: f.optional,
        default: def === null ? null : prismaDefault(def),
        ...(def !== null ? { defaultKey: def.replace(/\s+/g, '') } : {}),
        ...(name !== f.name ? { field: f.name } : {}),
      };
      t.columns[name] = col;
      if (/@id(?![\w.])/.test(f.line)) {
        t.primaryKey = [name];
        const pkMap = namedArg(attrArgs(f.line, '@id'), 'map');
        if (pkMap) t.primaryKeyName = pkMap;
        col.nullable = false;
      }
      if (/@unique(?![\w.])/.test(f.line)) {
        t.uniques.push({ name: namedArg(attrArgs(f.line, '@unique'), 'map') ?? `${t.name}_${name}_key`, columns: [name] });
      }
    }
    for (const line of m.body.split('\n').map((l) => l.trim())) {
      if (line.startsWith('@@id')) {
        const a = attrArgs(line, '@@id');
        t.primaryKey = listOf(a).map((x) => colName(modelName, x));
        const pkMap = namedArg(a, 'map');
        if (pkMap) t.primaryKeyName = pkMap;
        for (const c of t.primaryKey) if (t.columns[c]) t.columns[c].nullable = false;
      } else if (line.startsWith('@@unique')) {
        const a = attrArgs(line, '@@unique');
        const cols = listOf(a).map((x) => colName(modelName, x));
        t.uniques.push({ name: namedArg(a, 'map') ?? `${t.name}_${cols.join('_')}_key`, columns: cols });
      } else if (line.startsWith('@@index')) {
        const a = attrArgs(line, '@@index');
        const cols = listOf(a).map((x) => colName(modelName, x));
        t.indexes.push({ name: namedArg(a, 'map') ?? `${t.name}_${cols.join('_')}_idx`, columns: cols, unique: false });
      }
    }
    schema.tables[m.key] = t;
  }
  return { provider };
}

/** Display form of a Prisma @default(...) argument. */
function prismaDefault(arg: string): string {
  const a = arg.trim();
  if (a === 'now()') return 'current_timestamp';
  if (a === 'autoincrement()') return 'autoincrement';
  if (/^"(.*)"$/.test(a)) return `'${a.slice(1, -1)}'`;
  return a;
}
