/**
 * Which code still uses a changed table (through the Phase 2 dependency graph), and which
 * lines still name a dropped or renamed column in a query.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ts as TsNs } from 'ts-morph';
import type { ProjectType } from '../../core/config.js';
import { describeDependents, summarizeDependents } from '../dependencies/format.js';
import { buildGraph, dependentsOf, indexGraph, type Dependent, type GraphIndex } from '../dependencies/graph.js';
import { decodeText } from '../dependencies/files.js';
import { looksLikeSql } from '../dependencies/sql.js';
import type { DepGraph } from '../dependencies/types.js';
import { bareName, type DbSchema } from './types.js';

export interface TableUsage {
  summary: string;
  lines: string[];
  /** Files with a direct uses-table edge (not schema/migration files). */
  directFiles: string[];
}

export interface ColumnRef {
  file: string;
  line: number;
  text: string;
}

export class UsageIndex {
  private idx: GraphIndex;
  constructor(
    readonly graph: DepGraph,
    private readonly root: string,
  ) {
    this.idx = indexGraph(graph);
  }

  static async build(root: string, projectType?: ProjectType): Promise<UsageIndex> {
    return new UsageIndex(await buildGraph(root, { projectType }), root);
  }

  /** Code that depends on a table (schema and migration files excluded). */
  tableUsage(tableKey: string): TableUsage | null {
    const node = `table:${bareName(tableKey)}`;
    const deps: Dependent[] = dependentsOf(this.idx, node).filter((d) => this.graph.files[d.node]?.role !== 'schema' && !d.node.endsWith('.sql') && !d.node.endsWith('.prisma'));
    if (deps.length === 0) return null;
    const directFiles = deps.filter((d) => d.depth === 1 && d.via.type === 'uses-table').map((d) => d.node);
    return { summary: summarizeDependents(this.graph, deps), lines: describeDependents(this.graph, deps, 10), directFiles };
  }

  /**
   * Lines in `files` that reference `column` of the table in a query: Supabase filters and
   * selects, SQL strings, Prisma `where`/`select`/`data` keys and Drizzle `table.column`.
   */
  async columnRefs(files: string[], schema: DbSchema | null, tableKey: string, column: string): Promise<ColumnRef[]> {
    if (files.length === 0) return [];
    const ts = (await import('ts-morph')).ts;
    const table = schema?.tables[tableKey];
    const field = table?.columns[column]?.field;
    const names = new Set([column, ...(field ? [field] : [])]);
    const codeNames = new Set(table?.codeNames ?? []);
    const prismaAccessor = table?.prismaAccessor;
    const bare = bareName(tableKey);
    const out: ColumnRef[] = [];
    for (const file of files) {
      let text: string;
      try {
        text = decodeText(await readFile(path.join(this.root, file)));
      } catch {
        continue;
      }
      if (![...names].some((n) => text.includes(n))) continue;
      const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, /\.[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      const seen = new Set<number>();
      const add = (node: TsNs.Node, why: string) => {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        if (seen.has(line)) return;
        seen.add(line);
        out.push({ file, line, text: why });
      };
      scanFile(ts, sf, { names, codeNames, prismaAccessor, bare }, add);
    }
    return out;
  }
}

const SUPABASE_COLUMN_METHODS = new Set([
  'select', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in', 'contains', 'containedBy', 'order',
  'match', 'filter', 'not', 'or', 'textSearch', 'rangeGt', 'rangeLt', 'overlaps', 'insert', 'update', 'upsert',
]);

const tokenRe = (name: string) => new RegExp(`(^|[^\\w$])"?${name.replace(/[$]/g, '\\$')}"?($|[^\\w$])`);

function scanFile(
  ts: typeof TsNs,
  sf: TsNs.SourceFile,
  want: { names: Set<string>; codeNames: Set<string>; prismaAccessor?: string; bare: string },
  add: (n: TsNs.Node, why: string) => void,
): void {
  const res = [...want.names].map((n) => ({ n, re: tokenRe(n) }));
  const mentions = (s: string) => res.find((r) => r.re.test(s))?.n;

  /** Does a call chain contain `.from('<table>')` (Supabase) ? */
  const chainFromTable = (e: TsNs.Expression): boolean => {
    let cur: TsNs.Expression = e;
    for (let i = 0; i < 30; i++) {
      if (ts.isCallExpression(cur)) {
        const callee = cur.expression;
        if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'from') {
          const a0 = cur.arguments[0];
          if (a0 && ts.isStringLiteralLike(a0)) return a0.text.split('.').pop()!.toLowerCase() === want.bare;
        }
        cur = ts.isPropertyAccessExpression(callee) ? callee.expression : callee;
      } else if (ts.isPropertyAccessExpression(cur) || ts.isParenthesizedExpression(cur) || ts.isAwaitExpression(cur)) {
        cur = cur.expression;
      } else return false;
    }
    return false;
  };
  /** `prisma.<model>.<method>(...)` where model is the table's accessor. */
  const prismaModelCall = (c: TsNs.CallExpression): boolean => {
    const callee = c.expression;
    if (!ts.isPropertyAccessExpression(callee)) return false;
    const obj = callee.expression;
    return ts.isPropertyAccessExpression(obj) && (obj.name.text === want.prismaAccessor || obj.name.text.toLowerCase() === want.bare);
  };
  const objectKeys = (n: TsNs.Node, fn: (key: TsNs.Node, name: string) => void) => {
    const walk = (x: TsNs.Node) => {
      if (ts.isPropertyAssignment(x) || ts.isShorthandPropertyAssignment(x)) {
        const k = x.name;
        if (ts.isIdentifier(k) || ts.isStringLiteral(k)) fn(k, k.text);
      }
      ts.forEachChild(x, walk);
    };
    walk(n);
  };

  const visit = (node: TsNs.Node) => {
    // SQL in strings and templates.
    if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) {
      const text = ts.isTemplateExpression(node) ? [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(' ? ') : node.text;
      if (looksLikeSql(text) && new RegExp(`\\b${want.bare}\\b`, 'i').test(text)) {
        const hit = mentions(text);
        if (hit) add(node, `SQL query mentions ${hit}`);
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      if (SUPABASE_COLUMN_METHODS.has(method) && chainFromTable(node)) {
        for (const a of node.arguments) {
          if (ts.isStringLiteralLike(a)) {
            const parts = a.text.split(/[\s,()!:.]+|->>?/).filter(Boolean);
            const hit = parts.find((p) => want.names.has(p));
            if (hit) add(a, `.${method}() uses column ${hit}`);
          } else if (ts.isObjectLiteralExpression(a) || ts.isArrayLiteralExpression(a)) {
            objectKeys(a, (k, name) => want.names.has(name) && add(k, `.${method}() sets column ${name}`));
          }
        }
      } else if (prismaModelCall(node)) {
        for (const a of node.arguments) objectKeys(a, (k, name) => want.names.has(name) && add(k, `Prisma ${method}() uses field ${name}`));
      }
    }
    // Drizzle: users.email
    if (ts.isPropertyAccessExpression(node) && want.names.has(node.name.text)) {
      const obj = node.expression;
      const objName = ts.isIdentifier(obj) ? obj.text : ts.isPropertyAccessExpression(obj) ? obj.name.text : '';
      if (want.codeNames.has(objName)) add(node, `${objName}.${node.name.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}
