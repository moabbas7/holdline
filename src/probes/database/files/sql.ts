/**
 * Replays SQL migration files onto a schema model. Statements are parsed with libpg-query
 * (Postgres's own parser, loaded lazily); only DDL that shapes tables, enums, views and
 * row-level security is applied. Everything else (functions, DO blocks, grants, triggers,
 * data changes) is ignored.
 */
import { canonPg, SERIAL_TYPES } from '../canon.js';
import { emptyTable, type DbSchema, type Policy, type Table } from '../types.js';
import { plural } from '../../../plural.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Node = any;

type ParseFn = (sql: string) => Promise<{ stmts?: { stmt: Node; stmt_location?: number; stmt_len?: number }[] }>;

let parser: Promise<ParseFn> | null = null;
/** libpg-query (a WASM build of the Postgres parser) is loaded only when there are SQL files to read. */
async function loadParser(): Promise<ParseFn> {
  parser ??= import('libpg-query').then((m) => m.parse as ParseFn);
  return parser;
}

// --- AST helpers ---------------------------------------------------------------------

const str = (n: Node): string | undefined => n?.String?.sval;
const names = (list: Node[] | undefined): string[] => (list ?? []).map(str).filter((s): s is string => s !== undefined);

/** Comparable key for an expression: its AST without source positions. */
export function exprKey(n: Node): string {
  return JSON.stringify(n, (k, v) => (k === 'location' ? undefined : v));
}

const SVF: Record<string, string> = {
  SVFOP_CURRENT_DATE: 'current_date',
  SVFOP_CURRENT_TIME: 'current_time',
  SVFOP_CURRENT_TIME_N: 'current_time',
  SVFOP_CURRENT_TIMESTAMP: 'current_timestamp',
  SVFOP_CURRENT_TIMESTAMP_N: 'current_timestamp',
  SVFOP_LOCALTIME: 'localtime',
  SVFOP_LOCALTIMESTAMP: 'localtimestamp',
  SVFOP_CURRENT_ROLE: 'current_role',
  SVFOP_CURRENT_USER: 'current_user',
  SVFOP_USER: 'user',
  SVFOP_SESSION_USER: 'session_user',
  SVFOP_CURRENT_CATALOG: 'current_catalog',
  SVFOP_CURRENT_SCHEMA: 'current_schema',
};

/** Best-effort SQL text for an expression, for display only. */
export function renderExpr(n: Node, depth = 0): string {
  if (!n || depth > 20) return '…';
  const r = (x: Node) => renderExpr(x, depth + 1);
  if (n.A_Const) {
    const c = n.A_Const;
    if (c.isnull) return 'null';
    if (c.sval) return `'${(c.sval.sval ?? '').replace(/'/g, "''")}'`;
    if (c.ival) return String(c.ival.ival ?? 0);
    if (c.fval) return String(c.fval.fval);
    if (c.boolval) return c.boolval.boolval ? 'true' : 'false';
    if (c.bsval) return String(c.bsval.bsval);
    return '?';
  }
  if (n.ColumnRef) return (n.ColumnRef.fields ?? []).map((f: Node) => (f.A_Star ? '*' : str(f))).join('.');
  if (n.FuncCall) {
    const f = n.FuncCall;
    const args = f.agg_star ? '*' : (f.args ?? []).map(r).join(', ');
    return `${names(f.funcname).filter((x) => x !== 'pg_catalog').join('.')}(${args})`;
  }
  if (n.TypeCast) return `${r(n.TypeCast.arg)}::${renderType(n.TypeCast.typeName)}`;
  if (n.A_Expr) {
    const e = n.A_Expr;
    const op = names(e.name).join(' ');
    if (e.kind === 'AEXPR_IN') return `${r(e.lexpr)} ${op === '=' ? 'in' : 'not in'} (${(e.rexpr?.List?.items ?? []).map(r).join(', ')})`;
    if (e.kind === 'AEXPR_OP_ANY') return `${r(e.lexpr)} ${op} any(${r(e.rexpr)})`;
    if (e.kind === 'AEXPR_LIKE') return `${r(e.lexpr)} ${op === '~~' ? 'like' : 'not like'} ${r(e.rexpr)}`;
    if (e.kind === 'AEXPR_ILIKE') return `${r(e.lexpr)} ${op === '~~*' ? 'ilike' : 'not ilike'} ${r(e.rexpr)}`;
    return e.lexpr ? `${r(e.lexpr)} ${op} ${r(e.rexpr)}` : `${op} ${r(e.rexpr)}`;
  }
  if (n.BoolExpr) {
    const b = n.BoolExpr;
    const parts = (b.args ?? []).map((a: Node) => (a.BoolExpr ? `(${r(a)})` : r(a)));
    if (b.boolop === 'NOT_EXPR') return `not ${parts[0]}`;
    return parts.join(b.boolop === 'AND_EXPR' ? ' and ' : ' or ');
  }
  if (n.NullTest) return `${r(n.NullTest.arg)} is ${n.NullTest.nulltesttype === 'IS_NULL' ? '' : 'not '}null`;
  if (n.BooleanTest) return `${r(n.BooleanTest.arg)} is ${String(n.BooleanTest.booltesttype).replace(/^IS_/, '').replace(/_/g, ' ').toLowerCase()}`;
  if (n.SQLValueFunction) return SVF[n.SQLValueFunction.op] ?? 'current_value';
  if (n.SubLink) return n.SubLink.subLinkType === 'EXISTS_SUBLINK' ? 'exists (select …)' : '(select …)';
  if (n.A_ArrayExpr) return `array[${(n.A_ArrayExpr.elements ?? []).map(r).join(', ')}]`;
  if (n.CoalesceExpr) return `coalesce(${(n.CoalesceExpr.args ?? []).map(r).join(', ')})`;
  if (n.CaseExpr) return 'case … end';
  if (n.ParamRef) return `$${n.ParamRef.number}`;
  if (n.RowExpr) return `(${(n.RowExpr.args ?? []).map(r).join(', ')})`;
  if (n.A_Indirection) return r(n.A_Indirection.arg);
  return '…';
}

/** Canonical type name from a TypeName node. */
export function renderType(t: Node): string {
  if (!t) return 'unknown';
  const parts = names(t.names);
  const base = parts.length > 1 && parts[0] === 'pg_catalog' ? parts.at(-1)! : parts.join('.');
  const mods = (t.typmods ?? []).map((m: Node) => {
    const c = m.A_Const;
    if (c?.ival) return c.ival.ival ?? 0;
    if (c?.sval) return c.sval.sval;
    if (m.ColumnRef) return renderExpr(m);
    return '?';
  });
  // "timestamp(3) with time zone" is parsed as timestamptz with a modifier: canonPg handles it.
  // interval fields (`interval day to second`) are encoded as a bitmask modifier; drop it.
  const cleanMods = base === 'interval' ? [] : mods;
  return canonPg(base, cleanMods, (t.arrayBounds ?? []).length);
}

// --- Replay --------------------------------------------------------------------------

export interface SqlReplayResult {
  warnings: string[];
}

function keyOf(rel: Node): string {
  return `${rel?.schemaname ?? 'public'}.${rel?.relname}`;
}

function keyFromNames(parts: string[]): string {
  return parts.length > 1 ? `${parts.at(-2)}.${parts.at(-1)}` : `public.${parts[0]}`;
}

function roleName(r: Node): string {
  const s = r?.RoleSpec;
  if (!s) return '?';
  if (s.roletype === 'ROLESPEC_PUBLIC') return 'public';
  if (s.roletype === 'ROLESPEC_CURRENT_USER') return 'current_user';
  if (s.roletype === 'ROLESPEC_SESSION_USER') return 'session_user';
  if (s.roletype === 'ROLESPEC_CURRENT_ROLE') return 'current_role';
  return s.rolename;
}

const pkName = (t: Table) => t.primaryKeyName ?? `${t.name}_pkey`;

class Replayer {
  constructor(
    private readonly schema: DbSchema,
    private readonly file: string,
  ) {}

  private table(key: string): Table | undefined {
    return this.schema.tables[key];
  }

  /** Apply one statement. Unknown statements are ignored. */
  apply(stmt: Node): void {
    const [kind] = Object.keys(stmt);
    const s = stmt[kind!];
    switch (kind) {
      case 'CreateStmt':
        return this.createTable(s);
      case 'AlterTableStmt':
        return this.alterTable(s);
      case 'RenameStmt':
        return this.rename(s);
      case 'DropStmt':
        return this.drop(s);
      case 'IndexStmt':
        return this.createIndex(s);
      case 'CreateEnumStmt': {
        const k = keyFromNames(names(s.typeName));
        this.schema.enums[k] = names(s.vals);
        return;
      }
      case 'AlterEnumStmt': {
        const k = keyFromNames(names(s.typeName));
        const vals = this.schema.enums[k];
        if (!vals) return;
        if (s.oldVal) {
          const i = vals.indexOf(s.oldVal);
          if (i >= 0) vals[i] = s.newVal;
        } else if (s.newVal && !vals.includes(s.newVal)) {
          const anchor = s.newValNeighbor ? vals.indexOf(s.newValNeighbor) : -1;
          if (anchor < 0) vals.push(s.newVal);
          else vals.splice(s.newValIsAfter === false ? anchor : anchor + 1, 0, s.newVal);
        }
        return;
      }
      case 'ViewStmt':
        this.schema.views[keyOf(s.view)] = { materialized: false, definedIn: this.file };
        return;
      case 'CreateTableAsStmt':
        if (s.objtype === 'OBJECT_MATVIEW') this.schema.views[keyOf(s.into?.rel)] = { materialized: true, definedIn: this.file };
        return;
      case 'CreatePolicyStmt': {
        const t = this.table(keyOf(s.table));
        if (!t) return;
        t.policies[s.policy_name] = {
          name: s.policy_name,
          command: (s.cmd_name ?? 'all').toLowerCase(),
          roles: s.roles?.length ? s.roles.map(roleName).sort() : ['public'],
          permissive: s.permissive !== false,
          using: s.qual ? renderExpr(s.qual) : null,
          check: s.with_check ? renderExpr(s.with_check) : null,
          usingKey: s.qual ? exprKey(s.qual) : null,
          checkKey: s.with_check ? exprKey(s.with_check) : null,
        };
        return;
      }
      case 'AlterPolicyStmt': {
        const p: Policy | undefined = this.table(keyOf(s.table))?.policies[s.policy_name];
        if (!p) return;
        if (s.roles?.length) p.roles = s.roles.map(roleName).sort();
        if (s.qual) [p.using, p.usingKey] = [renderExpr(s.qual), exprKey(s.qual)];
        if (s.with_check) [p.check, p.checkKey] = [renderExpr(s.with_check), exprKey(s.with_check)];
        return;
      }
      case 'AlterObjectSchemaStmt': {
        if (s.objectType !== 'OBJECT_TABLE') return;
        const from = keyOf(s.relation);
        const t = this.table(from);
        if (!t) return;
        delete this.schema.tables[from];
        t.schema = s.newschema;
        this.schema.tables[`${t.schema}.${t.name}`] = t;
        return;
      }
    }
  }

  private createTable(s: Node): void {
    const rel = s.relation;
    if (rel?.relpersistence === 't' || s.partbound) return;
    const key = keyOf(rel);
    if (s.if_not_exists && this.table(key)) return;
    const t = emptyTable(rel.schemaname ?? 'public', rel.relname);
    t.definedIn = this.file;
    t.rls = false;
    for (const el of s.tableElts ?? []) {
      if (el.ColumnDef) this.addColumn(t, el.ColumnDef);
      else if (el.Constraint) this.addConstraint(t, el.Constraint);
    }
    this.schema.tables[key] = t;
  }

  private addColumn(t: Table, cd: Node): void {
    const rawBase = names(cd.typeName?.names).at(-1) ?? '';
    const serial = SERIAL_TYPES.has(rawBase.toLowerCase());
    const col = {
      name: cd.colname as string,
      type: renderType(cd.typeName),
      nullable: !serial,
      default: serial ? `nextval('${t.name}_${cd.colname}_seq'::regclass)` : null,
      defaultKey: serial ? 'serial' : undefined,
    } as Table['columns'][string];
    t.columns[col.name] = col;
    for (const c of cd.constraints ?? []) this.columnConstraint(t, col.name, c.Constraint);
  }

  private columnConstraint(t: Table, col: string, c: Node): void {
    const column = t.columns[col];
    if (!c || !column) return;
    switch (c.contype) {
      case 'CONSTR_NOTNULL':
        column.nullable = false;
        return;
      case 'CONSTR_NULL':
        column.nullable = true;
        return;
      case 'CONSTR_DEFAULT':
        column.default = renderExpr(c.raw_expr);
        column.defaultKey = exprKey(c.raw_expr);
        return;
      case 'CONSTR_IDENTITY':
        column.identity = true;
        column.nullable = false;
        return;
      case 'CONSTR_GENERATED':
        column.generated = true;
        return;
      case 'CONSTR_PRIMARY':
        t.primaryKey = [col];
        if (c.conname) t.primaryKeyName = c.conname;
        column.nullable = false;
        return;
      case 'CONSTR_UNIQUE':
        t.uniques.push({ name: c.conname ?? `${t.name}_${col}_key`, columns: [col] });
        return;
      case 'CONSTR_FOREIGN':
        t.foreignKeys.push({
          name: c.conname ?? `${t.name}_${col}_fkey`,
          columns: [col],
          refTable: keyOf(c.pktable),
          refColumns: this.refColumns(c),
          ...(c.fk_del_action && c.fk_del_action !== 'a' ? { onDelete: FK_ACTION[c.fk_del_action] } : {}),
        });
        return;
    }
  }

  /** `references users` without columns means the referenced table's primary key. */
  private refColumns(c: Node): string[] {
    const cols = names(c.pk_attrs);
    if (cols.length) return cols;
    const ref = this.table(keyOf(c.pktable));
    return ref?.primaryKey.length ? [...ref.primaryKey] : [];
  }

  private addConstraint(t: Table, c: Node): void {
    switch (c.contype) {
      case 'CONSTR_PRIMARY': {
        let cols = names(c.keys);
        if (c.indexname) {
          const i = t.indexes.findIndex((x) => x.name === c.indexname);
          if (i >= 0) cols = t.indexes.splice(i, 1)[0]!.columns;
        }
        t.primaryKey = cols;
        t.primaryKeyName = c.conname ?? undefined;
        for (const k of cols) if (t.columns[k]) t.columns[k].nullable = false;
        return;
      }
      case 'CONSTR_UNIQUE': {
        let cols = names(c.keys);
        if (c.indexname) {
          const i = t.indexes.findIndex((x) => x.name === c.indexname);
          if (i >= 0) cols = t.indexes.splice(i, 1)[0]!.columns;
        }
        t.uniques.push({ name: c.conname ?? `${t.name}_${cols.join('_')}_key`, columns: cols });
        return;
      }
      case 'CONSTR_FOREIGN': {
        const cols = names(c.fk_attrs);
        t.foreignKeys.push({
          name: c.conname ?? `${t.name}_${cols.join('_')}_fkey`,
          columns: cols,
          refTable: keyOf(c.pktable),
          refColumns: this.refColumns(c),
          ...(c.fk_del_action && c.fk_del_action !== 'a' ? { onDelete: FK_ACTION[c.fk_del_action] } : {}),
        });
        return;
      }
    }
  }

  private dropConstraint(t: Table, name: string): void {
    if (t.primaryKey.length && pkName(t) === name) {
      t.primaryKey = [];
      t.primaryKeyName = undefined;
      return;
    }
    t.uniques = t.uniques.filter((u) => u.name !== name);
    t.foreignKeys = t.foreignKeys.filter((f) => f.name !== name);
  }

  private alterTable(s: Node): void {
    if (s.objtype && s.objtype !== 'OBJECT_TABLE') return;
    const t = this.table(keyOf(s.relation));
    if (!t) return;
    for (const { AlterTableCmd: cmd } of s.cmds ?? []) {
      if (!cmd) continue;
      const col = cmd.name ? t.columns[cmd.name] : undefined;
      switch (cmd.subtype) {
        case 'AT_AddColumn':
          if (cmd.def?.ColumnDef && !(cmd.missing_ok && t.columns[cmd.def.ColumnDef.colname])) this.addColumn(t, cmd.def.ColumnDef);
          break;
        case 'AT_DropColumn':
          if (col) this.dropColumn(t, col.name);
          break;
        case 'AT_AlterColumnType':
          if (col) col.type = renderType(cmd.def?.ColumnDef?.typeName);
          break;
        case 'AT_SetNotNull':
          if (col) col.nullable = false;
          break;
        case 'AT_DropNotNull':
          if (col) col.nullable = true;
          break;
        case 'AT_ColumnDefault':
          if (col) {
            col.default = cmd.def ? renderExpr(cmd.def) : null;
            col.defaultKey = cmd.def ? exprKey(cmd.def) : undefined;
          }
          break;
        case 'AT_AddIdentity':
          if (col) [col.identity, col.nullable] = [true, false];
          break;
        case 'AT_DropIdentity':
          if (col) col.identity = false;
          break;
        case 'AT_AddConstraint':
          if (cmd.def?.Constraint) this.addConstraint(t, cmd.def.Constraint);
          break;
        case 'AT_DropConstraint':
          if (cmd.name) this.dropConstraint(t, cmd.name);
          break;
        case 'AT_EnableRowSecurity':
          t.rls = true;
          break;
        case 'AT_DisableRowSecurity':
          t.rls = false;
          break;
      }
    }
  }

  private dropColumn(t: Table, name: string): void {
    delete t.columns[name];
    t.primaryKey = t.primaryKey.includes(name) ? [] : t.primaryKey;
    t.uniques = t.uniques.filter((u) => !u.columns.includes(name));
    t.foreignKeys = t.foreignKeys.filter((f) => !f.columns.includes(name));
    t.indexes = t.indexes.filter((i) => !i.columns.includes(name));
  }

  private rename(s: Node): void {
    switch (s.renameType) {
      case 'OBJECT_TABLE': {
        const from = keyOf(s.relation);
        const t = this.table(from);
        if (!t) return;
        delete this.schema.tables[from];
        t.name = s.newname;
        this.schema.tables[`${t.schema}.${t.name}`] = t;
        this.schema.renames.push({ kind: 'table', table: from, from: s.relation.relname, to: s.newname, file: this.file });
        return;
      }
      case 'OBJECT_COLUMN': {
        if (s.relationType && s.relationType !== 'OBJECT_TABLE') return;
        const key = keyOf(s.relation);
        const t = this.table(key);
        const col = t?.columns[s.subname];
        if (!t || !col) return;
        // Rebuild to keep column order.
        t.columns = Object.fromEntries(
          Object.entries(t.columns).map(([k, v]) => (k === s.subname ? [s.newname, { ...v, name: s.newname }] : [k, v])),
        );
        const swap = (cols: string[]) => cols.map((c) => (c === s.subname ? s.newname : c));
        t.primaryKey = swap(t.primaryKey);
        for (const u of t.uniques) u.columns = swap(u.columns);
        for (const f of t.foreignKeys) f.columns = swap(f.columns);
        for (const i of t.indexes) i.columns = swap(i.columns);
        this.schema.renames.push({ kind: 'column', table: key, from: s.subname, to: s.newname, file: this.file });
        return;
      }
      case 'OBJECT_TABCONSTRAINT': {
        const t = this.table(keyOf(s.relation));
        if (!t) return;
        if (t.primaryKey.length && pkName(t) === s.subname) t.primaryKeyName = s.newname;
        for (const x of [...t.uniques, ...t.foreignKeys]) if (x.name === s.subname) x.name = s.newname;
        return;
      }
      case 'OBJECT_INDEX': {
        const name = s.relation?.relname;
        for (const t of Object.values(this.schema.tables)) for (const i of t.indexes) if (i.name === name) i.name = s.newname;
        return;
      }
      case 'OBJECT_POLICY': {
        const t = this.table(keyOf(s.relation));
        const p = t?.policies[s.subname];
        if (!t || !p) return;
        delete t.policies[s.subname];
        t.policies[s.newname] = { ...p, name: s.newname };
        return;
      }
      case 'OBJECT_VIEW':
      case 'OBJECT_MATVIEW': {
        const from = keyOf(s.relation);
        const v = this.schema.views[from];
        if (!v) return;
        delete this.schema.views[from];
        this.schema.views[`${s.relation.schemaname ?? 'public'}.${s.newname}`] = v;
        return;
      }
      case 'OBJECT_TYPE': {
        const from = keyFromNames(names(s.object?.List?.items));
        const vals = this.schema.enums[from];
        if (!vals) return;
        delete this.schema.enums[from];
        this.schema.enums[`${from.split('.')[0]}.${s.newname}`] = vals;
        return;
      }
    }
  }

  private drop(s: Node): void {
    const objects: Node[] = s.objects ?? [];
    switch (s.removeType) {
      case 'OBJECT_TABLE':
        for (const o of objects) delete this.schema.tables[keyFromNames(names(o.List?.items))];
        return;
      case 'OBJECT_VIEW':
      case 'OBJECT_MATVIEW':
        for (const o of objects) delete this.schema.views[keyFromNames(names(o.List?.items))];
        return;
      case 'OBJECT_INDEX':
        for (const o of objects) {
          const parts = names(o.List?.items);
          const name = parts.at(-1);
          for (const t of Object.values(this.schema.tables)) t.indexes = t.indexes.filter((i) => i.name !== name);
        }
        return;
      case 'OBJECT_TYPE':
        for (const o of objects) delete this.schema.enums[keyFromNames(names(o.TypeName?.names))];
        return;
      case 'OBJECT_POLICY':
        for (const o of objects) {
          const parts = names(o.List?.items);
          const policy = parts.at(-1)!;
          const t = this.table(keyFromNames(parts.slice(0, -1)));
          if (t) delete t.policies[policy];
        }
        return;
      case 'OBJECT_SCHEMA':
        if (s.behavior !== 'DROP_CASCADE') return;
        for (const o of objects) {
          const name = str(o);
          for (const k of Object.keys(this.schema.tables)) if (k.startsWith(`${name}.`)) delete this.schema.tables[k];
          for (const k of Object.keys(this.schema.views)) if (k.startsWith(`${name}.`)) delete this.schema.views[k];
          for (const k of Object.keys(this.schema.enums)) if (k.startsWith(`${name}.`)) delete this.schema.enums[k];
        }
        return;
    }
  }

  private createIndex(s: Node): void {
    const t = this.table(keyOf(s.relation));
    if (!t) return;
    const cols: string[] = (s.indexParams ?? []).map((p: Node) => {
      const e = p.IndexElem;
      return e?.name ?? (e?.expr ? renderExpr(e.expr) : '?');
    });
    const name = s.idxname ?? `${t.name}_${cols.join('_')}_idx`;
    if (s.if_not_exists && t.indexes.some((i) => i.name === name)) return;
    t.indexes = t.indexes.filter((i) => i.name !== name);
    t.indexes.push({ name, columns: cols, unique: Boolean(s.unique), ...(s.whereClause ? { where: renderExpr(s.whereClause) } : {}) });
  }
}

const DO_ENUM_DDL = /\b(create\s+type\s+[\w."]+\s+as\s+enum\s*\([^)]*\)|alter\s+type\s+[\w."]+\s+(?:add\s+value|rename\s+value)\b[^;]*)/gi;

async function enumStatementsInDo(d: Node, parse: ParseFn): Promise<Node[]> {
  const body: string | undefined = (d.args ?? []).find((a: Node) => a.DefElem?.defname === 'as')?.DefElem?.arg?.String?.sval;
  if (!body) return [];
  const out: Node[] = [];
  for (const m of body.replace(/--[^\n]*/g, ' ').matchAll(DO_ENUM_DDL)) {
    try {
      for (const st of (await parse(m[1]!)).stmts ?? []) {
        if (st.stmt.CreateEnumStmt || st.stmt.AlterEnumStmt) out.push(st.stmt);
      }
    } catch {
      /* not a statement after all */
    }
  }
  return out;
}

/**
 * Split SQL text into statements on `;`, respecting quotes, dollar quoting and comments.
 * psql meta-command lines (`\set …`) become their own (unparseable) piece.
 */
export function splitStatements(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  const n = text.length;
  /** Emit text[start, end) as a statement; the next one starts after `skip` characters. */
  const push = (end: number, skip = 1) => {
    const piece = text.slice(start, end).trim();
    if (piece && !/^(--[^\n]*\n?|\s)*$/.test(piece)) out.push(piece);
    start = end + skip;
  };
  while (i < n) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (ch === '-' && next === '-') {
      const e = text.indexOf('\n', i);
      i = e < 0 ? n : e + 1;
    } else if (ch === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (text[i] === '/' && text[i + 1] === '*') (depth++, (i += 2));
        else if (text[i] === '*' && text[i + 1] === '/') (depth--, (i += 2));
        else i++;
      }
    } else if (ch === "'" || ch === '"') {
      i++;
      while (i < n) {
        if (text[i] === ch && text[i + 1] === ch) i += 2;
        else if (text[i] === ch) break;
        else i++;
      }
      i++;
    } else if (ch === '$') {
      const m = /^\$([A-Za-z_][\w]*)?\$/.exec(text.slice(i, i + 64));
      if (m) {
        const end = text.indexOf(m[0], i + m[0].length);
        i = end < 0 ? n : end + m[0].length;
      } else i++;
    } else if (ch === '\\' && (i === 0 || text[i - 1] === '\n')) {
      const e = text.indexOf('\n', i);
      const lineEnd = e < 0 ? n : e;
      push(i, 0);
      push(lineEnd, 0);
      i = lineEnd;
    } else if (ch === ';') {
      push(i);
      i++;
    } else i++;
  }
  push(n);
  return out;
}

const FK_ACTION: Record<string, string> = { r: 'restrict', c: 'cascade', n: 'set null', d: 'set default', a: 'no action' };

/**
 * Apply SQL files, in order, to `schema`. A file that fails to parse is skipped with a
 * warning (it may use syntax for another database).
 */
export async function replaySqlFiles(
  schema: DbSchema,
  files: { path: string; text: string }[],
): Promise<SqlReplayResult> {
  const warnings: string[] = [];
  if (files.length === 0) return { warnings };
  const parse = await loadParser();
  for (const f of files) {
    let stmts: { stmt: Node }[];
    try {
      stmts = (await parse(f.text)).stmts ?? [];
    } catch {
      // One unsupported statement (a psql meta-command, another database's syntax) fails
      // the whole file. Parse statement by statement so only the bad ones are skipped;
      // otherwise every table in the file would look dropped.
      stmts = [];
      let bad = 0;
      let firstErr = '';
      for (const piece of splitStatements(f.text)) {
        try {
          stmts.push(...((await parse(piece)).stmts ?? []));
        } catch (e) {
          bad++;
          firstErr ||= (e instanceof Error ? e.message : String(e)).slice(0, 100);
        }
      }
      if (bad > 0) warnings.push(`${f.path}: skipped ${plural(bad, 'statement')} that could not be parsed (${firstErr})`);
    }
    const r = new Replayer(schema, f.path);
    for (const { stmt } of stmts) {
      // Postgres has no CREATE TYPE IF NOT EXISTS, so migrations often create enums inside
      // `DO $$ BEGIN IF NOT EXISTS (…) THEN CREATE TYPE … AS ENUM (…); END IF; END $$`.
      // Enum DDL is taken from DO blocks; anything else in them is ignored.
      const inner = stmt.DoStmt ? await enumStatementsInDo(stmt.DoStmt, parse) : [stmt];
      for (const st of inner) {
        try {
          r.apply(st);
        } catch {
          /* an unexpected AST shape in one statement must not stop the rest */
        }
      }
    }
  }
  return { warnings };
}
