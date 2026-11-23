/** Compares two schemas and classifies each difference as a regression or a change. */
import { displayName, type Column, type DbSchema, type Table } from './types.js';

export type ChangeKind =
  | 'table-dropped'
  | 'table-renamed'
  | 'table-added'
  | 'column-dropped'
  | 'column-renamed'
  | 'column-added'
  | 'type-changed'
  | 'nullability-changed'
  | 'default-changed'
  | 'primary-key-changed'
  | 'foreign-key-removed'
  | 'foreign-key-added'
  | 'unique-removed'
  | 'unique-added'
  | 'index-removed'
  | 'index-added'
  | 'enum-dropped'
  | 'enum-value-removed'
  | 'enum-value-added'
  | 'enum-added'
  | 'view-dropped'
  | 'view-added'
  | 'rls-disabled'
  | 'rls-enabled'
  | 'policy-removed'
  | 'policy-changed'
  | 'policy-added';

export interface SchemaChange {
  kind: ChangeKind;
  severity: 'regression' | 'change';
  /** Table key ("public.users"), when the change is about a table. */
  table?: string;
  column?: string;
  /** New name for renames. */
  to?: string;
  /** Name of the index/constraint/policy/enum/view. */
  name?: string;
  /** Human-readable description. */
  text: string;
  /** For renames: whether it was an explicit RENAME or inferred. */
  inferred?: boolean;
}

/** Identity of a change, used to merge the same change seen in the live database and in files. */
export const changeKey = (c: SchemaChange) => [c.kind, c.table, c.column, c.to, c.name].join('\0');

const sig = (cols: string[]) => cols.join(',');
const hasDefault = (c: Column) => c.default !== null || Boolean(c.identity) || Boolean(c.generated);
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Differences from `before` to `after`. `renames` are explicit renames that appeared since
 * `before` (from migrations); other renames are inferred from a drop + add of the same shape.
 */
export function diffSchemas(before: DbSchema, after: DbSchema): SchemaChange[] {
  const out: SchemaChange[] = [];
  const push = (c: SchemaChange) => out.push(c);
  const beforeRenames = new Set(before.renames.map((r) => JSON.stringify([r.kind, r.table, r.from, r.to])));
  const newRenames = after.renames.filter((r) => !beforeRenames.has(JSON.stringify([r.kind, r.table, r.from, r.to])));

  // --- Tables --------------------------------------------------------------------------
  const droppedTables = Object.keys(before.tables).filter((k) => !after.tables[k]);
  const addedTables = new Set(Object.keys(after.tables).filter((k) => !before.tables[k]));
  const tableRenamedTo = new Map<string, { to: string; inferred: boolean }>();
  for (const r of newRenames.filter((x) => x.kind === 'table')) {
    const schemaName = r.table.split('.')[0];
    const toKey = `${schemaName}.${r.to}`;
    // Follow chains (a → b → c) to the final name.
    let final = toKey;
    for (const r2 of newRenames) if (r2.kind === 'table' && r2.table === final) final = `${schemaName}.${r2.to}`;
    if (before.tables[r.table] && after.tables[final] && !after.tables[r.table]) tableRenamedTo.set(r.table, { to: final, inferred: false });
  }
  for (const k of droppedTables) {
    if (tableRenamedTo.has(k)) continue;
    const cols = Object.keys(before.tables[k]!.columns).sort().join(',');
    const twins = [...addedTables].filter((a) => !tableRenamedToHas(tableRenamedTo, a) && Object.keys(after.tables[a]!.columns).sort().join(',') === cols && cols !== '');
    if (twins.length === 1) tableRenamedTo.set(k, { to: twins[0]!, inferred: true });
  }
  const renamedTable = (k: string) => tableRenamedTo.get(k)?.to ?? k;
  for (const k of droppedTables) {
    const ren = tableRenamedTo.get(k);
    if (ren) {
      addedTables.delete(ren.to);
      push({
        kind: 'table-renamed',
        severity: 'regression',
        table: k,
        to: ren.to,
        inferred: ren.inferred,
        text: `Table ${displayName(k)} ${ren.inferred ? 'appears to have been renamed' : 'renamed'} to ${displayName(ren.to)}`,
      });
      diffTable(before.tables[k]!, after.tables[ren.to]!, k, newRenames, renamedTable, push);
    } else {
      push({ kind: 'table-dropped', severity: 'regression', table: k, text: `Table ${displayName(k)} dropped` });
    }
  }
  for (const k of [...addedTables].sort()) push({ kind: 'table-added', severity: 'change', table: k, text: `Table ${displayName(k)} added` });
  for (const k of Object.keys(before.tables)) {
    if (after.tables[k]) diffTable(before.tables[k]!, after.tables[k]!, k, newRenames, renamedTable, push);
  }

  // --- Enums ---------------------------------------------------------------------------
  for (const [k, vals] of Object.entries(before.enums)) {
    const now = after.enums[k];
    if (!now) {
      push({ kind: 'enum-dropped', severity: 'regression', name: k, text: `Enum ${displayName(k)} dropped` });
      continue;
    }
    for (const v of vals) {
      if (!now.includes(v)) push({ kind: 'enum-value-removed', severity: 'regression', name: k, column: v, text: `Enum ${displayName(k)}: value '${v}' removed` });
    }
    for (const v of now) {
      if (!vals.includes(v)) push({ kind: 'enum-value-added', severity: 'change', name: k, column: v, text: `Enum ${displayName(k)}: value '${v}' added` });
    }
  }
  for (const k of Object.keys(after.enums)) {
    if (!before.enums[k]) push({ kind: 'enum-added', severity: 'change', name: k, text: `Enum ${displayName(k)} added` });
  }

  // --- Views ---------------------------------------------------------------------------
  for (const k of Object.keys(before.views)) {
    if (!after.views[k]) push({ kind: 'view-dropped', severity: 'regression', name: k, table: k, text: `View ${displayName(k)} dropped` });
  }
  for (const k of Object.keys(after.views)) {
    if (!before.views[k]) push({ kind: 'view-added', severity: 'change', name: k, text: `View ${displayName(k)} added` });
  }
  return out;
}

const tableRenamedToHas = (m: Map<string, { to: string }>, key: string) => [...m.values()].some((v) => v.to === key);

function diffTable(
  b: Table,
  a: Table,
  key: string,
  renames: DbSchema['renames'],
  renamedTable: (key: string) => string,
  push: (c: SchemaChange) => void,
): void {
  const name = displayName(key);
  const dropped = Object.keys(b.columns).filter((c) => !a.columns[c]);
  const added = new Set(Object.keys(a.columns).filter((c) => !b.columns[c]));

  // Column renames: explicit ones first, then a single drop + add of the same type.
  const renamedTo = new Map<string, { to: string; inferred: boolean }>();
  for (const r of renames) {
    if (r.kind !== 'column' || (r.table !== key && displayName(r.table) !== name)) continue;
    let final = r.to;
    for (const r2 of renames) if (r2.kind === 'column' && r2.table === r.table && r2.from === final) final = r2.to;
    if (b.columns[r.from] && !a.columns[r.from] && a.columns[final]) renamedTo.set(r.from, { to: final, inferred: false });
  }
  const leftDrops = dropped.filter((c) => !renamedTo.has(c));
  const leftAdds = [...added].filter((c) => ![...renamedTo.values()].some((v) => v.to === c));
  if (leftDrops.length === 1 && leftAdds.length === 1 && b.columns[leftDrops[0]!]!.type === a.columns[leftAdds[0]!]!.type) {
    renamedTo.set(leftDrops[0]!, { to: leftAdds[0]!, inferred: true });
  }

  for (const c of dropped) {
    const ren = renamedTo.get(c);
    if (ren) {
      added.delete(ren.to);
      push({
        kind: 'column-renamed',
        severity: 'regression',
        table: key,
        column: c,
        to: ren.to,
        inferred: ren.inferred,
        text: `Column ${name}.${c} ${ren.inferred ? 'appears to have been renamed' : 'renamed'} to ${ren.to}`,
      });
      compareColumn(b.columns[c]!, a.columns[ren.to]!, key, ren.to, push);
    } else {
      push({ kind: 'column-dropped', severity: 'regression', table: key, column: c, text: `Column ${name}.${c} dropped` });
    }
  }
  for (const c of [...added].sort()) {
    const col = a.columns[c]!;
    const breaking = !col.nullable && !hasDefault(col);
    push({
      kind: 'column-added',
      severity: breaking ? 'regression' : 'change',
      table: key,
      column: c,
      text: breaking
        ? `Column ${name}.${c} added as NOT NULL without a default (inserts that don't set it will fail)`
        : `Column ${name}.${c} added (${col.type}${col.nullable ? '' : ', not null'})`,
    });
  }
  for (const c of Object.keys(b.columns)) if (a.columns[c]) compareColumn(b.columns[c]!, a.columns[c]!, key, c, push);

  // Keys, constraints and indexes. Before-side columns and referenced tables are mapped
  // through renames, so an index on a renamed column isn't reported as removed + added.
  const rn = (c: string) => renamedTo.get(c)?.to ?? c;
  const rcols = (cols: string[]) => cols.map(rn);
  if (!sameSet(rcols(b.primaryKey), a.primaryKey)) {
    push({
      kind: 'primary-key-changed',
      severity: 'change',
      table: key,
      text: `Primary key of ${name} changed: (${b.primaryKey.join(', ') || 'none'}) → (${a.primaryKey.join(', ') || 'none'})`,
    });
  }
  const uniqueSigs = (t: Table, map: (c: string[]) => string[]) =>
    new Set([...t.uniques.map((u) => sig(map(u.columns))), ...t.indexes.filter((i) => i.unique && !i.where).map((i) => sig(map(i.columns))), sig(map(t.primaryKey))]);
  const aUniques = uniqueSigs(a, (c) => c);
  const bUniques = uniqueSigs(b, rcols);
  for (const u of b.uniques) {
    if (!aUniques.has(sig(rcols(u.columns))) && rcols(u.columns).every((c) => a.columns[c])) {
      push({ kind: 'unique-removed', severity: 'change', table: key, name: u.name, text: `Unique constraint on ${name}(${u.columns.join(', ')}) removed` });
    }
  }
  for (const u of a.uniques) {
    if (!bUniques.has(sig(u.columns))) push({ kind: 'unique-added', severity: 'change', table: key, name: u.name, text: `Unique constraint on ${name}(${u.columns.join(', ')}) added` });
  }
  const fkSig = (f: Table['foreignKeys'][number], map: (c: string[]) => string[] = (c) => c, table = (t: string) => t) =>
    `${sig(map(f.columns))}>${displayName(table(f.refTable))}(${sig(f.refColumns)})`;
  const aFks = new Set(a.foreignKeys.map((f) => fkSig(f)));
  const bFks = new Set(b.foreignKeys.map((f) => fkSig(f, rcols, renamedTable)));
  for (const f of b.foreignKeys) {
    // A foreign key that disappeared because its column or the referenced table was dropped is reported there.
    if (!aFks.has(fkSig(f, rcols, renamedTable)) && rcols(f.columns).every((c) => a.columns[c])) {
      push({
        kind: 'foreign-key-removed',
        severity: 'change',
        table: key,
        name: f.name,
        text: `Foreign key ${name}(${f.columns.join(', ')}) → ${displayName(f.refTable)}(${f.refColumns.join(', ')}) removed`,
      });
    }
  }
  for (const f of a.foreignKeys) {
    if (!bFks.has(fkSig(f))) {
      push({
        kind: 'foreign-key-added',
        severity: 'change',
        table: key,
        name: f.name,
        text: `Foreign key ${name}(${f.columns.join(', ')}) → ${displayName(f.refTable)}(${f.refColumns.join(', ')}) added`,
      });
    }
  }
  const idxSig = (i: Table['indexes'][number], map: (c: string[]) => string[] = (c) => c) => `${i.unique}:${sig(map(i.columns))}:${i.where ?? ''}`;
  const aIdx = new Set(a.indexes.map((i) => idxSig(i)));
  const bIdx = new Set(b.indexes.map((i) => idxSig(i, rcols)));
  for (const i of b.indexes) {
    if (aIdx.has(idxSig(i, rcols)) || !rcols(i.columns).every((c) => a.columns[c] || !b.columns[c])) continue;
    // A unique index replaced by a unique constraint on the same columns is not a removal.
    if (i.unique && !i.where && aUniques.has(sig(rcols(i.columns)))) continue;
    push({ kind: 'index-removed', severity: 'change', table: key, name: i.name, text: `Index ${i.name} on ${name}(${i.columns.join(', ')}) removed` });
  }
  for (const i of a.indexes) {
    if (!bIdx.has(idxSig(i))) push({ kind: 'index-added', severity: 'change', table: key, name: i.name, text: `Index ${i.name} on ${name}(${i.columns.join(', ')}) added` });
  }

  // Row-level security.
  if (b.rls === true && a.rls === false) {
    push({ kind: 'rls-disabled', severity: 'regression', table: key, text: `Row-level security turned OFF on ${name} (every row is now visible to anyone who can query the table)` });
  } else if (b.rls === false && a.rls === true) {
    push({ kind: 'rls-enabled', severity: 'change', table: key, text: `Row-level security turned on for ${name}` });
  }
  for (const [pn, p] of Object.entries(b.policies)) {
    const now = a.policies[pn];
    if (!now) {
      push({ kind: 'policy-removed', severity: 'regression', table: key, name: pn, text: `Policy "${pn}" on ${name} removed (${p.command}${p.roles.length ? ` to ${p.roles.join(', ')}` : ''})` });
      continue;
    }
    const what: string[] = [];
    if (p.command !== now.command) what.push(`command ${p.command} → ${now.command}`);
    if (!sameSet(p.roles, now.roles)) what.push(`roles ${p.roles.join(', ')} → ${now.roles.join(', ')}`);
    if (p.permissive !== now.permissive) what.push(now.permissive ? 'now permissive' : 'now restrictive');
    if ((p.usingKey ?? p.using) !== (now.usingKey ?? now.using)) what.push(`using: ${p.using ?? '(none)'} → ${now.using ?? '(none)'}`);
    if ((p.checkKey ?? p.check) !== (now.checkKey ?? now.check)) what.push(`with check: ${p.check ?? '(none)'} → ${now.check ?? '(none)'}`);
    if (what.length) push({ kind: 'policy-changed', severity: 'regression', table: key, name: pn, text: `Policy "${pn}" on ${name} changed: ${what.join('; ')}` });
  }
  for (const pn of Object.keys(a.policies)) {
    if (!b.policies[pn]) push({ kind: 'policy-added', severity: 'change', table: key, name: pn, text: `Policy "${pn}" on ${name} added` });
  }
}

function compareColumn(b: Column, a: Column, key: string, col: string, push: (c: SchemaChange) => void): void {
  const name = `${displayName(key)}.${col}`;
  if (b.type !== a.type) {
    push({ kind: 'type-changed', severity: 'regression', table: key, column: col, text: `Column ${name} type changed: ${b.type} → ${a.type}` });
  }
  if (b.nullable !== a.nullable) {
    if (!a.nullable) {
      const breaking = !hasDefault(a);
      push({
        kind: 'nullability-changed',
        severity: breaking ? 'regression' : 'change',
        table: key,
        column: col,
        text: breaking
          ? `Column ${name} is now NOT NULL and has no default (inserts that don't set it will fail)`
          : `Column ${name} is now NOT NULL (has a default)`,
      });
    } else {
      push({ kind: 'nullability-changed', severity: 'change', table: key, column: col, text: `Column ${name} is now nullable (code may receive nulls)` });
    }
  }
  if ((b.defaultKey ?? b.default) !== (a.defaultKey ?? a.default)) {
    push({ kind: 'default-changed', severity: 'change', table: key, column: col, text: `Column ${name} default changed: ${b.default ?? '(none)'} → ${a.default ?? '(none)'}` });
  }
}

// --- Drift between the live database and the schema files ------------------------------

export interface DriftItem {
  key: string;
  text: string;
}

/** Where the live database and the schema files disagree (tables, columns, types, nullability). */
export function schemaDrift(live: DbSchema, files: DbSchema): DriftItem[] {
  const out: DriftItem[] = [];
  const onlyFiles = Object.keys(files.tables).filter((k) => !live.tables[k]);
  const onlyLive = Object.keys(live.tables).filter((k) => !files.tables[k]);
  for (const k of onlyFiles) out.push({ key: `files-only:${k}`, text: `Table ${displayName(k)} is in the schema files but not in the database (migration not applied?)` });
  for (const k of onlyLive) out.push({ key: `live-only:${k}`, text: `Table ${displayName(k)} is in the database but not in the schema files` });
  for (const [k, ft] of Object.entries(files.tables)) {
    const lt = live.tables[k];
    if (!lt) continue;
    const n = displayName(k);
    for (const [c, fc] of Object.entries(ft.columns)) {
      const lc = lt.columns[c];
      if (!lc) {
        out.push({ key: `col-files-only:${k}.${c}`, text: `Column ${n}.${c} is in the schema files but not in the database` });
        continue;
      }
      if (lc.type !== fc.type && !(live.dialect === 'sqlite' && sqliteAffinity(lc.type) === sqliteAffinity(fc.type))) {
        out.push({ key: `type:${k}.${c}`, text: `Column ${n}.${c}: database type ${lc.type}, schema files say ${fc.type}` });
      }
      if (lc.nullable !== fc.nullable) {
        out.push({ key: `null:${k}.${c}`, text: `Column ${n}.${c}: ${lc.nullable ? 'nullable' : 'NOT NULL'} in the database, ${fc.nullable ? 'nullable' : 'NOT NULL'} in the schema files` });
      }
    }
    for (const c of Object.keys(lt.columns)) {
      if (!ft.columns[c]) out.push({ key: `col-live-only:${k}.${c}`, text: `Column ${n}.${c} is in the database but not in the schema files` });
    }
    if (ft.rls !== null && lt.rls !== null && ft.rls !== lt.rls) {
      out.push({ key: `rls:${k}`, text: `Row-level security on ${n} is ${lt.rls ? 'on' : 'off'} in the database but ${ft.rls ? 'on' : 'off'} in the schema files` });
    }
  }
  return out;
}

/** SQLite type affinity (https://sqlite.org/datatype3.html §3.1). */
function sqliteAffinity(t: string): string {
  const s = t.toLowerCase();
  if (s.includes('int')) return 'integer';
  if (/char|clob|text/.test(s)) return 'text';
  if (s === '' || s.includes('blob')) return 'blob';
  if (/real|floa|doub/.test(s)) return 'real';
  return 'numeric';
}
