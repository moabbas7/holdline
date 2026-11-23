/**
 * Reads Drizzle table definitions (pgTable/sqliteTable/mysqlTable, pgEnum, indexes,
 * references, RLS policies) with the TypeScript parser bundled in ts-morph, loaded only
 * when a file looks like a Drizzle schema.
 */
import type { ts as TsNs } from 'ts-morph';
import { canonPg, canonSqlite } from '../canon.js';
import { emptyTable, type Column, type DbSchema, type Dialect, type Table } from '../types.js';

type TS = typeof TsNs;

const TABLE_FNS: Record<string, Dialect> = {
  pgTable: 'postgres',
  sqliteTable: 'sqlite',
  mysqlTable: 'mysql',
  singlestoreTable: 'mysql',
};
const CREATORS: Record<string, Dialect> = {
  pgTableCreator: 'postgres',
  sqliteTableCreator: 'sqlite',
  mysqlTableCreator: 'mysql',
};
const ENUM_FNS = new Set(['pgEnum', 'mysqlEnum']);

/** Cheap text test so ts-morph is only loaded for files that may define Drizzle tables. */
export const looksLikeDrizzle = (text: string) =>
  /\b(pgTable|sqliteTable|mysqlTable|singlestoreTable|pgTableCreator|sqliteTableCreator|mysqlTableCreator|pgEnum)\s*[.(<]/.test(text) ||
  /\.table\s*\(/.test(text) && /\bpgSchema\s*\(/.test(text);

interface PendingRef {
  table: Table;
  columns: string[];
  targetLocal: string;
  targetKeys: string[];
  name?: string;
  onDelete?: string;
}

interface DrizzleTable {
  key: string;
  table: Table;
  /** Drizzle property key → column name. */
  keyToCol: Map<string, string>;
}

export async function applyDrizzle(schema: DbSchema, files: { path: string; text: string }[]): Promise<{ dialect: Dialect | null }> {
  const candidates = files.filter((f) => looksLikeDrizzle(f.text));
  if (candidates.length === 0) return { dialect: null };
  const ts: TS = (await import('ts-morph')).ts;
  const byLocal = new Map<string, DrizzleTable>();
  const pending: PendingRef[] = [];
  let dialect: Dialect | null = null;

  for (const f of candidates) {
    const sf = ts.createSourceFile(f.path, f.text, ts.ScriptTarget.Latest, true, f.path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const enumLocals = new Map<string, string>();
    const schemaLocals = new Map<string, string>();
    const creatorLocals = new Map<string, Dialect>();
    const text = (n: TsNs.Node) => n.getText(sf);
    const strArg = (n: TsNs.Node | undefined) => (n && ts.isStringLiteralLike(n) ? n.text : undefined);
    const objProp = (o: TsNs.Node | undefined, name: string): TsNs.Expression | undefined => {
      if (!o || !ts.isObjectLiteralExpression(o)) return undefined;
      for (const p of o.properties) {
        if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === name) return p.initializer;
        if (ts.isShorthandPropertyAssignment(p) && p.name.text === name) return p.name;
      }
      return undefined;
    };
    const unwrap = (e: TsNs.Expression): TsNs.Expression => {
      while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
      return e;
    };
    /** `a.b().c()` → base call + method calls, innermost first. */
    const chain = (e: TsNs.Expression): { base: TsNs.CallExpression | null; methods: { name: string; args: readonly TsNs.Expression[] }[] } => {
      const methods: { name: string; args: readonly TsNs.Expression[] }[] = [];
      let cur = unwrap(e);
      while (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
        const inner = unwrap(cur.expression.expression);
        if (!ts.isCallExpression(inner)) break;
        methods.unshift({ name: cur.expression.name.text, args: cur.arguments });
        cur = inner;
      }
      return { base: ts.isCallExpression(cur) ? cur : null, methods };
    };
    const calleeName = (c: TsNs.CallExpression): string => {
      const e = c.expression;
      if (ts.isIdentifier(e)) return e.text;
      if (ts.isPropertyAccessExpression(e)) return e.name.text;
      return '';
    };
    /** Last property name of `t.email`, `users.email`, `schema.users.email`. */
    const propName = (e: TsNs.Expression | undefined): string | undefined => {
      const u = e && unwrap(e);
      return u && ts.isPropertyAccessExpression(u) ? u.name.text : undefined;
    };

    const parseColumn = (t: Table, d: Dialect, key: string, expr: TsNs.Expression, keyToCol: Map<string, string>) => {
      const { base, methods } = chain(expr);
      if (!base) return;
      const builder = calleeName(base);
      const args = base.arguments;
      const nameArg = strArg(args[0]);
      const opts = args.find((a) => ts.isObjectLiteralExpression(a));
      const name = nameArg ?? key;
      const num = (p: string) => {
        const v = objProp(opts, p);
        return v && ts.isNumericLiteral(v) ? Number(v.text) : undefined;
      };
      let type: string;
      if (ts.isIdentifier(base.expression) && enumLocals.has(builder)) {
        type = d === 'postgres' ? canonPg(enumLocals.get(builder)!) : 'enum';
      } else if (d === 'postgres') {
        type = pgBuilderType(builder, (p) => num(p), (p) => {
          const v = objProp(opts, p);
          return v ? v.kind === ts.SyntaxKind.TrueKeyword : undefined;
        });
      } else if (d === 'sqlite') {
        type = canonSqlite(builder === 'int' ? 'integer' : builder);
      } else {
        type = builder.toLowerCase();
      }
      const col: Column = { name, type, nullable: true, default: null, ...(name !== key ? { field: key } : {}) };
      if (['serial', 'bigserial', 'smallserial'].includes(builder)) {
        col.nullable = false;
        col.default = `nextval('${t.name}_${name}_seq'::regclass)`;
        col.defaultKey = 'serial';
      }
      for (const m of methods) {
        switch (m.name) {
          case 'notNull':
            col.nullable = false;
            break;
          case 'primaryKey':
            t.primaryKey = [name];
            col.nullable = false;
            break;
          case 'unique':
            t.uniques.push({ name: strArg(m.args[0]) ?? `${t.name}_${name}_unique`, columns: [name] });
            break;
          case 'default':
            col.default = m.args[0] ? text(m.args[0]) : null;
            col.defaultKey = col.default?.replace(/\s+/g, '');
            break;
          case 'defaultNow':
            [col.default, col.defaultKey] = ['now()', 'now()'];
            break;
          case 'defaultRandom':
            [col.default, col.defaultKey] = ['gen_random_uuid()', 'gen_random_uuid()'];
            break;
          case 'array':
            col.type += '[]';
            break;
          case 'generatedAlwaysAsIdentity':
          case 'generatedByDefaultAsIdentity':
            col.identity = true;
            col.nullable = false;
            break;
          case 'generatedAlwaysAs':
            col.generated = true;
            break;
          case 'references': {
            const fn = m.args[0];
            let body: TsNs.Node | undefined = fn && ts.isArrowFunction(fn) ? fn.body : undefined;
            if (body && ts.isBlock(body)) body = undefined;
            const target = body ? unwrap(body as TsNs.Expression) : undefined;
            if (target && ts.isPropertyAccessExpression(target)) {
              const obj = unwrap(target.expression);
              const targetLocal = ts.isIdentifier(obj) ? obj.text : ts.isPropertyAccessExpression(obj) ? obj.name.text : '';
              const od = objProp(m.args[1], 'onDelete');
              pending.push({ table: t, columns: [name], targetLocal, targetKeys: [target.name.text], ...(od && ts.isStringLiteralLike(od) ? { onDelete: od.text } : {}) });
            }
            break;
          }
        }
      }
      t.columns[name] = col;
      keyToCol.set(key, name);
    };

    const parseExtra = (t: Table, d: Dialect, fn: TsNs.Expression, keyToCol: Map<string, string>) => {
      const f = unwrap(fn);
      if (!ts.isArrowFunction(f) && !ts.isFunctionExpression(f)) return;
      let body: TsNs.Node = f.body;
      if (ts.isBlock(body)) {
        const ret = body.statements.find(ts.isReturnStatement);
        if (!ret?.expression) return;
        body = ret.expression;
      }
      const b = unwrap(body as TsNs.Expression);
      const items: TsNs.Expression[] = ts.isArrayLiteralExpression(b)
        ? [...b.elements]
        : ts.isObjectLiteralExpression(b)
          ? b.properties.filter(ts.isPropertyAssignment).map((p) => p.initializer)
          : [];
      const cols = (args: readonly TsNs.Expression[]) => args.map((a) => propName(a)).filter((k): k is string => !!k).map((k) => keyToCol.get(k) ?? k);
      for (const item of items) {
        const { base, methods } = chain(item);
        if (!base) continue;
        const kind = calleeName(base);
        const on = methods.find((m) => m.name === 'on');
        if (kind === 'index' || kind === 'uniqueIndex') {
          const c = on ? cols(on.args) : [];
          const where = methods.find((m) => m.name === 'where');
          t.indexes.push({
            name: strArg(base.arguments[0]) ?? `${t.name}_${c.join('_')}_index`,
            columns: c,
            unique: kind === 'uniqueIndex',
            ...(where?.args[0] ? { where: text(where.args[0]) } : {}),
          });
        } else if (kind === 'unique') {
          const c = on ? cols(on.args) : [];
          t.uniques.push({ name: strArg(base.arguments[0]) ?? `${t.name}_${c.join('_')}_unique`, columns: c });
        } else if (kind === 'primaryKey') {
          const a0 = base.arguments[0];
          const colsProp = objProp(a0, 'columns');
          const list = colsProp && ts.isArrayLiteralExpression(colsProp) ? [...colsProp.elements] : [...base.arguments];
          t.primaryKey = cols(list);
          const n = strArg(objProp(a0, 'name'));
          if (n) t.primaryKeyName = n;
          for (const c of t.primaryKey) if (t.columns[c]) t.columns[c].nullable = false;
        } else if (kind === 'foreignKey') {
          const a0 = base.arguments[0];
          const c = objProp(a0, 'columns');
          const fc = objProp(a0, 'foreignColumns');
          const local = c && ts.isArrayLiteralExpression(c) ? cols(c.elements) : [];
          const foreign = fc && ts.isArrayLiteralExpression(fc) ? [...fc.elements] : [];
          const first = foreign[0] && unwrap(foreign[0]);
          if (first && ts.isPropertyAccessExpression(first)) {
            const obj = unwrap(first.expression);
            const onDel = methods.find((m) => m.name === 'onDelete');
            pending.push({
              table: t,
              columns: local,
              targetLocal: ts.isIdentifier(obj) ? obj.text : ts.isPropertyAccessExpression(obj) ? obj.name.text : '',
              targetKeys: foreign.map((x) => propName(x) ?? ''),
              name: strArg(objProp(a0, 'name')),
              ...(onDel && strArg(onDel.args[0]) ? { onDelete: strArg(onDel.args[0]) } : {}),
            });
          }
        } else if (kind === 'pgPolicy' && d === 'postgres') {
          const name = strArg(base.arguments[0]);
          const o = base.arguments[1];
          if (!name) continue;
          const to = objProp(o, 'to');
          const roles = to
            ? ts.isArrayLiteralExpression(to)
              ? to.elements.map((e) => strArg(e) ?? text(e))
              : [strArg(to) ?? text(to)]
            : ['public'];
          const using = objProp(o, 'using');
          const check = objProp(o, 'withCheck');
          const sqlText = (e: TsNs.Expression | undefined) => (e ? text(e).replace(/^sql`|`$/g, '').trim() : null);
          t.policies[name] = {
            name,
            command: (strArg(objProp(o, 'for')) ?? 'all').toLowerCase(),
            roles: roles.map((r) => r.replace(/Role$/, '').toLowerCase()).sort(),
            permissive: strArg(objProp(o, 'as')) !== 'restrictive',
            using: sqlText(using),
            check: sqlText(check),
            usingKey: sqlText(using)?.replace(/\s+/g, ' ') ?? null,
            checkKey: sqlText(check)?.replace(/\s+/g, ' ') ?? null,
          };
          t.rls = true;
        }
      }
    };

    const visit = (node: TsNs.Node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const local = node.name.text;
        const { base, methods } = chain(node.initializer);
        if (base) {
          const callee = base.expression;
          const fnName = calleeName(base);
          const args = base.arguments;
          if (ts.isIdentifier(callee) && ENUM_FNS.has(fnName)) {
            const n = strArg(args[0]);
            const vals = args[1] && ts.isArrayLiteralExpression(args[1]) ? args[1].elements.map((e) => strArg(e)).filter((x): x is string => !!x) : [];
            if (n) {
              enumLocals.set(local, n);
              if (fnName === 'pgEnum') schema.enums[`public.${n}`] = vals;
            }
          } else if (ts.isIdentifier(callee) && fnName === 'pgSchema') {
            const n = strArg(args[0]);
            if (n) schemaLocals.set(local, n);
          } else if (ts.isIdentifier(callee) && CREATORS[fnName]) {
            creatorLocals.set(local, CREATORS[fnName]);
          } else {
            let d: Dialect | undefined;
            let tableSchema: string | undefined;
            if (ts.isIdentifier(callee)) d = TABLE_FNS[fnName] ?? creatorLocals.get(fnName);
            else if (ts.isPropertyAccessExpression(callee)) {
              const obj = unwrap(callee.expression);
              if (ts.isIdentifier(obj) && fnName === 'table' && schemaLocals.has(obj.text)) {
                d = 'postgres';
                tableSchema = schemaLocals.get(obj.text);
              } else if (ts.isIdentifier(obj) && TABLE_FNS[obj.text] && fnName === 'withRLS') {
                d = TABLE_FNS[obj.text];
              }
            }
            const name = strArg(args[0]);
            if (d && name) {
              dialect ??= d;
              const sch = tableSchema ?? (d === 'sqlite' ? 'main' : 'public');
              const t = emptyTable(sch, name);
              t.definedIn = f.path;
              t.codeNames = [local];
              t.rls = fnName === 'withRLS' || methods.some((m) => m.name === 'enableRLS') ? true : null;
              const keyToCol = new Map<string, string>();
              let colsNode = args[1] && unwrap(args[1]);
              if (colsNode && (ts.isArrowFunction(colsNode) || ts.isFunctionExpression(colsNode)) && !ts.isBlock(colsNode.body)) {
                colsNode = unwrap(colsNode.body as TsNs.Expression);
              }
              if (colsNode && ts.isObjectLiteralExpression(colsNode)) {
                for (const p of colsNode.properties) {
                  if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) {
                    parseColumn(t, d, p.name.text, p.initializer, keyToCol);
                  }
                }
              }
              if (args[2]) parseExtra(t, d, args[2], keyToCol);
              const key = `${sch}.${name}`;
              schema.tables[key] = t;
              byLocal.set(local, { key, table: t, keyToCol });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  for (const p of pending) {
    const target = byLocal.get(p.targetLocal);
    if (!target) continue;
    const refCols = p.targetKeys.map((k) => target.keyToCol.get(k) ?? k);
    p.table.foreignKeys.push({
      name: p.name ?? `${p.table.name}_${p.columns.join('_')}_${target.table.name}_${refCols.join('_')}_fk`,
      columns: p.columns,
      refTable: target.key,
      refColumns: refCols,
      ...(p.onDelete ? { onDelete: p.onDelete } : {}),
    });
  }
  return { dialect };
}

function pgBuilderType(builder: string, num: (p: string) => number | undefined, bool: (p: string) => boolean | undefined): string {
  switch (builder) {
    case 'varchar':
    case 'char': {
      const len = num('length');
      return canonPg(builder, len ? [len] : []);
    }
    case 'timestamp':
    case 'time': {
      const p = num('precision');
      return canonPg(bool('withTimezone') ? `${builder}tz` : builder, p !== undefined ? [p] : []);
    }
    case 'numeric':
    case 'decimal': {
      const p = num('precision');
      const s = num('scale');
      return canonPg('numeric', p !== undefined ? (s !== undefined ? [p, s] : [p]) : []);
    }
    case 'doublePrecision':
      return 'double precision';
    case 'vector': {
      const d = num('dimensions');
      return d ? `vector(${d})` : 'vector';
    }
    case 'int':
      return 'integer';
    default:
      return canonPg(builder);
  }
}
