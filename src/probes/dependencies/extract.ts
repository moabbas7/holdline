import type { Node as MorphNode, SourceFile, ts } from 'ts-morph';
import { ddlTables, looksLikeSql, normaliseTable, prismaModels, sqlTables } from './sql.js';
import { emptyFacts, type FileFacts, type ImportFact } from './types.js';

type TsMorph = typeof import('ts-morph');

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all']);
const SERVER_FRAMEWORK =
  /^(express|fastify|hono|hono\/.+|koa|koa-router|@koa\/router|restify|polka|h3|elysia|itty-router|@hapi\/hapi)$/;
const PRISMA_METHODS = new Set([
  'findMany',
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
  'count',
  'aggregate',
  'groupBy',
]);
const DRIZZLE_BUILDERS = new Set([
  'from',
  'insert',
  'update',
  'delete',
  'innerJoin',
  'leftJoin',
  'rightJoin',
  'fullJoin',
  'crossJoin',
]);
const DRIZZLE_TABLE_FNS = new Set(['pgTable', 'mysqlTable', 'sqliteTable', 'singlestoreTable']);
const DRIZZLE_TABLE_CREATORS = new Set(['pgTableCreator', 'mysqlTableCreator', 'sqliteTableCreator']);
const SWR_HOOKS = new Set(['useSWR', 'useSWRImmutable', 'useSWRInfinite', 'useSWRMutation']);

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?$/i;
/** Callees whose string arguments are SQL run against the project's own database. */
const SQL_CALLEES =
  /^(\$?queryRaw(Unsafe)?|\$?executeRaw(Unsafe)?|query|execute|exec|raw|prepare|unsafe|sql|any|one|many|none|oneOrNone|manyOrNone|whereRaw|fromRaw|joinRaw|selectRaw)$/;
const SQL_TAGS = /(^|\.)(sql|raw|\$?queryRaw(Unsafe)?|\$?executeRaw(Unsafe)?|query)$/i;
const SQL_VARS = /sql|query/i;
const MAX_VARIANTS = 8;

/** Marks a dynamic part of a URL built from a template or concatenation. */
const DYN = '${}';

/**
 * Normalise a URL to a route-like path: drop the origin, query and hash, drop a leading
 * dynamic base (`${API_URL}/users`), and turn dynamic segments into `:param`.
 * Returns null when nothing path-like is left.
 */
export function normaliseUrl(raw: string): string | null {
  let u = raw.trim();
  while (u.startsWith(DYN)) u = u.slice(DYN.length);
  const origin = /^(?:[a-z][a-z0-9+.-]*:)?\/\/([^/?#]*)/i.exec(u);
  if (origin) {
    // Another service (https://api.github.com/...) is never one of this project's routes.
    // A dynamic host (`https://${host}/api`) or localhost might be.
    if (!origin[1]!.includes(DYN) && !LOCAL_HOST.test(origin[1]!)) return null;
    u = u.slice(origin[0].length);
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(u)) {
    return null; // mailto:, data:, blob:
  }
  u = u.split(/[?#]/)[0]!;
  if (u === '' || u.includes(' ')) return null;
  if (!u.startsWith('/')) u = '/' + u;
  const segs = u
    .split('/')
    .filter(Boolean)
    .map((s) => (s.includes(DYN) ? ':param' : s));
  return '/' + segs.join('/');
}

export function joinUrl(base: string, url: string): string {
  if (!base || base === '/') return url;
  return (base.replace(/\/$/, '') + (url === '/' ? '' : url)) || '/';
}

/**
 * Extract dependency facts from a parsed source file. Top-level imports and exports use
 * ts-morph's API; the deep walk over expressions uses the underlying compiler nodes,
 * which is several times faster than wrapping every node.
 */
export function extractSource(sf: SourceFile, tsm: TsMorph): FileFacts {
  const facts = emptyFacts();
  const { Node } = tsm;
  const tsApi = tsm.ts;
  const K = tsApi.SyntaxKind;
  const raw = sf.compilerNode;
  const lineOf = (n: ts.Node) => raw.getLineAndCharacterOfPosition(n.getStart(raw)).line + 1;

  const addImport = (f: ImportFact) => {
    facts.imports.push(f);
    if (SERVER_FRAMEWORK.test(f.spec)) facts.serverFramework = true;
  };

  // --- Top-level statements: imports, exports, directives -------------------------------
  let prologue = true;
  for (const stmt of sf.getStatements()) {
    if (prologue) {
      const e = Node.isExpressionStatement(stmt) ? stmt.getExpression() : undefined;
      if (e && Node.isStringLiteral(e)) {
        if (e.getLiteralValue() === 'use server') facts.useServer = true;
      } else {
        prologue = false;
      }
    }

    if (Node.isImportDeclaration(stmt)) {
      const bindings: [string, string][] = [];
      const def = stmt.getDefaultImport();
      if (def) bindings.push([def.getText(), 'default']);
      const ns = stmt.getNamespaceImport();
      if (ns) bindings.push([ns.getText(), '*']);
      const named = stmt.getNamedImports();
      for (const n of named) bindings.push([n.getAliasNode()?.getText() ?? n.getName(), n.getName()]);
      const typeOnly =
        stmt.isTypeOnly() || (!def && !ns && named.length > 0 && named.every((n) => n.isTypeOnly()));
      addImport({
        spec: stmt.getModuleSpecifierValue(),
        names: bindings.map((b) => b[1]),
        bindings,
        kind: 'import',
        typeOnly,
        line: stmt.getStartLineNumber(),
      });
      continue;
    }

    if (Node.isImportEqualsDeclaration(stmt)) {
      const ref = stmt.getModuleReference();
      if (Node.isExternalModuleReference(ref)) {
        const e = ref.getExpression();
        if (e && Node.isStringLiteral(e)) {
          addImport({
            spec: e.getLiteralValue(),
            names: [],
            bindings: [[stmt.getName(), '*']],
            kind: 'require',
            typeOnly: stmt.isTypeOnly(),
            line: stmt.getStartLineNumber(),
          });
        }
      }
      continue;
    }

    if (Node.isExportDeclaration(stmt)) {
      const spec = stmt.getModuleSpecifierValue();
      const named = stmt.getNamedExports();
      const nsExport = stmt.getNamespaceExport();
      if (spec !== undefined) {
        if (nsExport) {
          facts.exports.push(nsExport.getName());
          addImport({ spec, names: ['*'], bindings: [], kind: 'reexport', typeOnly: stmt.isTypeOnly(), line: stmt.getStartLineNumber() });
        } else if (named.length === 0) {
          facts.starExports.push(spec);
          addImport({ spec, names: ['*'], bindings: [], kind: 'reexport', typeOnly: stmt.isTypeOnly(), line: stmt.getStartLineNumber() });
        } else {
          const names: string[] = [];
          for (const e of named) {
            const name = e.getName();
            facts.exports.push(e.getAliasNode()?.getText() ?? name);
            names.push(name);
          }
          addImport({ spec, names, bindings: [], kind: 'reexport', typeOnly: stmt.isTypeOnly(), line: stmt.getStartLineNumber() });
        }
      } else {
        for (const e of named) {
          const name = e.getName();
          const alias = e.getAliasNode()?.getText() ?? name;
          facts.exports.push(alias);
          if (alias !== name) facts.exportLocals[alias] = name;
        }
      }
      continue;
    }

    if (Node.isExportAssignment(stmt)) {
      if (stmt.isExportEquals()) {
        facts.hasCjs = true;
      } else {
        facts.exports.push('default');
        const e = stmt.getExpression();
        if (Node.isIdentifier(e)) facts.exportLocals.default = e.getText();
      }
      continue;
    }

    if (Node.isVariableStatement(stmt)) {
      if (!stmt.hasExportKeyword()) continue;
      for (const d of stmt.getDeclarations()) {
        const nameNode = d.getNameNode();
        if (Node.isIdentifier(nameNode)) facts.exports.push(nameNode.getText());
        else for (const b of nameNode.getDescendantsOfKind(K.BindingElement)) {
          const bn = b.getNameNode();
          if (Node.isIdentifier(bn)) facts.exports.push(bn.getText());
        }
      }
      continue;
    }

    if (Node.isExportable(stmt) && stmt.hasExportKeyword()) {
      const name = declName(stmt as MorphNode);
      if (stmt.hasDefaultKeyword()) {
        facts.exports.push('default');
        if (name) facts.exportLocals.default = name;
      } else if (name) {
        facts.exports.push(name);
      }
    }
  }

  // --- Deep walk over expressions ---------------------------------------------------------
  const tableCreators = new Set<string>();

  const cross = (a: string[], b: string[]) => a.flatMap((x) => b.map((y) => x + y)).slice(0, MAX_VARIANTS);
  /**
   * The possible texts of a string expression, with dynamic parts as DYN. A conditional
   * (`${isInvite ? 'invites' : 'users'}`) yields one variant per branch. Null when
   * nothing literal is known.
   */
  const textsOf = (n: ts.Node): string[] | null => {
    if (tsApi.isStringLiteral(n) || tsApi.isNoSubstitutionTemplateLiteral(n)) return [n.text];
    if (tsApi.isParenthesizedExpression(n)) return textsOf(n.expression);
    if (tsApi.isConditionalExpression(n)) {
      const t = textsOf(n.whenTrue);
      const f = textsOf(n.whenFalse);
      return t && f ? [...t, ...f].slice(0, MAX_VARIANTS) : null;
    }
    if (tsApi.isTemplateExpression(n)) {
      let acc = [n.head.text];
      for (const span of n.templateSpans) {
        acc = cross(acc, textsOf(span.expression) ?? [DYN]);
        acc = acc.map((x) => x + span.literal.text);
      }
      return acc;
    }
    if (tsApi.isBinaryExpression(n) && n.operatorToken.kind === K.PlusToken) {
      const l = textsOf(n.left);
      const r = textsOf(n.right);
      if (!l && !r) return null;
      return cross(l ?? [DYN], r ?? [DYN]);
    }
    return null;
  };
  const isLiteralish = (n: ts.Node | undefined) =>
    !!n &&
    (tsApi.isStringLiteral(n) ||
      tsApi.isNoSubstitutionTemplateLiteral(n) ||
      tsApi.isTemplateExpression(n) ||
      tsApi.isBinaryExpression(n) ||
      tsApi.isConditionalExpression(n));
  const urlsOf = (n: ts.Node | undefined): string[] => {
    if (!isLiteralish(n)) return [];
    const urls = (textsOf(n!) ?? []).map(normaliseUrl).filter((u): u is string => u !== null);
    return [...new Set(urls)];
  };
  const objProp = (n: ts.Node | undefined, key: string): ts.Expression | undefined => {
    if (!n || !tsApi.isObjectLiteralExpression(n)) return undefined;
    for (const p of n.properties) {
      if (tsApi.isPropertyAssignment(p) && p.name.getText(raw).replace(/['"]/g, '') === key) return p.initializer;
    }
    return undefined;
  };
  const strProp = (n: ts.Node | undefined, key: string): string | undefined => {
    const v = objProp(n, key);
    return v && (tsApi.isStringLiteral(v) || tsApi.isNoSubstitutionTemplateLiteral(v)) ? v.text : undefined;
  };
  /** fetch() method: GET when there are no options or the options literal has no method key; undefined when dynamic. */
  const fetchMethod = (opts: ts.Node | undefined): string | undefined => {
    if (!opts) return 'GET';
    if (!tsApi.isObjectLiteralExpression(opts)) return undefined;
    if (opts.properties.some((p) => !tsApi.isPropertyAssignment(p) && !tsApi.isShorthandPropertyAssignment(p) && !tsApi.isMethodDeclaration(p))) return undefined;
    const has = opts.properties.some((p) => p.name !== undefined && p.name.getText(raw).replace(/['"]/g, '') === 'method');
    if (!has) return 'GET';
    return strProp(opts, 'method')?.toUpperCase();
  };
  const isUpper = (s: string) => s[0] !== undefined && s[0] >= 'A' && s[0] <= 'Z';
  const receiverText = (e: ts.Expression): string | null => {
    if (tsApi.isIdentifier(e)) return e.text;
    if (e.kind === K.ThisKeyword) return 'this';
    if (tsApi.isPropertyAccessExpression(e)) {
      const inner = receiverText(e.expression);
      return inner === null ? null : `${inner}.${e.name.text}`;
    }
    return null;
  };

  const onCall = (call: ts.CallExpression) => {
    const callee = call.expression;
    const args = call.arguments;
    const a0 = args[0];

    if (callee.kind === K.ImportKeyword) {
      if (a0 && tsApi.isStringLiteralLike(a0)) {
        addImport({ spec: a0.text, names: [], bindings: [], kind: 'dynamic', typeOnly: false, line: lineOf(call) });
      }
      return;
    }

    if (tsApi.isIdentifier(callee)) {
      const name = callee.text;
      if (name === 'require' && args.length === 1 && a0 && tsApi.isStringLiteralLike(a0)) {
        const bindings: [string, string][] = [];
        const p = call.parent;
        if (p && tsApi.isVariableDeclaration(p) && tsApi.isIdentifier(p.name)) bindings.push([p.name.text, '*']);
        addImport({ spec: a0.text, names: [], bindings, kind: 'require', typeOnly: false, line: lineOf(call) });
      } else if (name === 'fetch') {
        for (const url of urlsOf(a0)) facts.httpCalls.push({ client: 'fetch', method: fetchMethod(args[1]), url, line: lineOf(call) });
      } else if (SWR_HOOKS.has(name)) {
        for (const url of urlsOf(a0)) facts.httpCalls.push({ client: 'swr', method: 'GET', url, line: lineOf(call) });
      } else if (name === 'axios') {
        const method = (strProp(a0, 'method') ?? strProp(args[1], 'method'))?.toUpperCase();
        const urls = urlsOf(a0).length > 0 ? urlsOf(a0) : urlsOf(objProp(a0, 'url'));
        for (const url of urls) facts.httpCalls.push({ client: 'axios', method, url, line: lineOf(call) });
      }
      return;
    }

    if (!tsApi.isPropertyAccessExpression(callee)) return;
    const method = callee.name.text;
    const obj = callee.expression;
    const recv = receiverText(obj);

    if (method === 'fetch' && (recv === 'window' || recv === 'globalThis' || recv === 'self')) {
      for (const url of urlsOf(a0)) facts.httpCalls.push({ client: 'fetch', method: fetchMethod(args[1]), url, line: lineOf(call) });
      return;
    }

    if (recv === 'axios' && (HTTP_METHODS.has(method) || method === 'request')) {
      const urls = method === 'request' ? urlsOf(objProp(a0, 'url')) : urlsOf(a0);
      const m = method === 'request' ? strProp(a0, 'method')?.toUpperCase() : method.toUpperCase();
      for (const url of urls) facts.httpCalls.push({ client: 'axios', method: m, url, line: lineOf(call) });
      return;
    }

    if (HTTP_METHODS.has(method) && recv && !recv.includes('.') && isLiteralish(a0)) {
      for (const rawText of textsOf(a0!) ?? []) {
        const url = normaliseUrl(rawText);
        if (!url) continue;
        const rest = args.slice(1);
        const hasHandlerArg = rest.some(
          (a) =>
            tsApi.isArrowFunction(a) ||
            tsApi.isFunctionExpression(a) ||
            tsApi.isIdentifier(a) ||
            tsApi.isCallExpression(a) ||
            tsApi.isPropertyAccessExpression(a),
        );
        facts.methodCalls.push({
          receiver: recv,
          method,
          url,
          argc: args.length,
          hasHandlerArg,
          pathLike: rawText.startsWith('/') || rawText === '*',
          line: lineOf(call),
        });
      }
    }

    if ((method === 'use' || method === 'route') && recv && args.length >= 2 && a0 && tsApi.isStringLiteralLike(a0) && a0.text.startsWith('/')) {
      const last = args[args.length - 1]!;
      const mount = mountTarget(last);
      if (mount) facts.mounts.push({ receiver: recv, prefix: a0.text, ...mount, line: lineOf(call) });
      return;
    }

    if (method === 'register' && recv && a0) {
      const prefix = strProp(args[1], 'prefix');
      const mount = mountTarget(a0);
      if (prefix && mount) facts.mounts.push({ receiver: recv, prefix, ...mount, line: lineOf(call) });
      return;
    }

    // Supabase: supabase.from('table'), supabase.schema('x').from('table'). Skip Array.from etc.
    if (method === 'from' && args.length === 1 && a0 && tsApi.isStringLiteralLike(a0)) {
      if (!(tsApi.isIdentifier(obj) && isUpper(obj.text))) {
        const t = /^[\w.]+$/.test(a0.text) ? normaliseTable(a0.text) : null;
        if (t) facts.tables.push({ name: t, via: 'supabase', line: lineOf(call) });
      }
      return;
    }

    if (DRIZZLE_BUILDERS.has(method) && a0 && !(tsApi.isIdentifier(obj) && isUpper(obj.text))) {
      // .from(users) or, with `import * as schema`, .from(schema.users)
      if (tsApi.isIdentifier(a0)) facts.drizzleRefs.push({ local: a0.text, line: lineOf(call) });
      else if (tsApi.isPropertyAccessExpression(a0) && tsApi.isIdentifier(a0.expression)) {
        facts.drizzleRefs.push({ local: `${a0.expression.text}.${a0.name.text}`, line: lineOf(call) });
      }
    }

    if (PRISMA_METHODS.has(method) && tsApi.isPropertyAccessExpression(obj)) {
      const model = obj.name.text;
      const inner = obj.expression;
      if (tsApi.isPropertyAccessExpression(inner) && inner.name.text === 'query' && (method === 'findMany' || method === 'findFirst')) {
        facts.drizzleQueryRefs.push({ name: model, line: lineOf(call) });
      } else if (!model.startsWith('$')) {
        const r = receiverText(inner);
        if (r) facts.prismaCalls.push({ receiver: r, model, line: lineOf(call) });
      }
    }
  };

  const mountTarget = (n: ts.Node): { local?: string; spec?: string } | null => {
    if (tsApi.isIdentifier(n)) return { local: n.text };
    if (tsApi.isCallExpression(n) && tsApi.isIdentifier(n.expression) && n.expression.text === 'require') {
      const a = n.arguments[0];
      if (a && tsApi.isStringLiteralLike(a)) return { spec: a.text };
    }
    return null;
  };

  const onVariable = (d: ts.VariableDeclaration) => {
    if (!tsApi.isIdentifier(d.name) || !d.initializer) return;
    let init = d.initializer;
    while (tsApi.isAwaitExpression(init) || tsApi.isParenthesizedExpression(init)) init = init.expression;
    if (!tsApi.isCallExpression(init)) return;
    const callee = init.expression;
    const local = d.name.text;
    if (tsApi.isPropertyAccessExpression(callee) && callee.name.text === 'create' && tsApi.isIdentifier(callee.expression) && callee.expression.text === 'axios') {
      const base = objProp(init.arguments[0], 'baseURL');
      const baseUrl = base ? (urlsOf(base)[0] ?? null) : null;
      facts.axiosInstances[local] = baseUrl ?? '';
      return;
    }
    if (tsApi.isIdentifier(callee)) {
      if (DRIZZLE_TABLE_CREATORS.has(callee.text)) {
        tableCreators.add(local);
      } else if (DRIZZLE_TABLE_FNS.has(callee.text) || tableCreators.has(callee.text)) {
        const a0 = init.arguments[0];
        const t = a0 && tsApi.isStringLiteralLike(a0) ? normaliseTable(a0.text) : null;
        if (t) facts.drizzleDefs[local] = t;
      }
    }
  };

  /** Name of a call's callee: `query` for pool.query(...), `sql` for sql(...). */
  const calleeName = (c: ts.CallExpression) =>
    tsApi.isIdentifier(c.expression) ? c.expression.text : tsApi.isPropertyAccessExpression(c.expression) ? c.expression.name.text : '';
  /**
   * Is this string used as SQL against the project's database? Only strings handed to a
   * query-like call (pool.query, prisma.$queryRaw, sql`…`, db.execute, …) or stored in a
   * variable named like sql/query count, so UI text ("Select a file from your…") and
   * queries for other services (Google Ads' GAQL in a `query:` option) are ignored.
   */
  const inSqlContext = (n: ts.Node): boolean => {
    let cur: ts.Node = n;
    let p = n.parent;
    while (
      p &&
      (tsApi.isParenthesizedExpression(p) ||
        tsApi.isAsExpression(p) ||
        tsApi.isNonNullExpression(p) ||
        (tsApi.isBinaryExpression(p) && p.operatorToken.kind === K.PlusToken))
    ) {
      cur = p;
      p = p.parent;
    }
    if (!p) return false;
    if (tsApi.isTaggedTemplateExpression(p)) return SQL_TAGS.test(p.tag.getText(raw));
    if (tsApi.isCallExpression(p)) return p.arguments.some((a) => a === cur) && SQL_CALLEES.test(calleeName(p));
    if (tsApi.isVariableDeclaration(p)) return p.initializer === cur && tsApi.isIdentifier(p.name) && SQL_VARS.test(p.name.text);
    if (tsApi.isPropertyAssignment(p) && /^(sql|text)$/.test(p.name.getText(raw))) {
      // pg: client.query({ text: 'SELECT …', values })
      const obj = p.parent;
      const call = obj?.parent;
      return !!call && tsApi.isCallExpression(call) && SQL_CALLEES.test(calleeName(call));
    }
    return false;
  };

  const onText = (text: string, n: ts.Node) => {
    if (!looksLikeSql(text) || !inSqlContext(n)) return;
    const line = lineOf(n);
    for (const t of sqlTables(text)) facts.tables.push({ name: t, via: 'sql', line });
  };

  const visit = (node: ts.Node): void => {
    switch (node.kind) {
      case K.CallExpression:
        onCall(node as ts.CallExpression);
        break;
      case K.VariableDeclaration:
        onVariable(node as ts.VariableDeclaration);
        break;
      case K.StringLiteral:
      case K.NoSubstitutionTemplateLiteral:
        if ((node as ts.StringLiteral).text.length >= 10) onText((node as ts.StringLiteral).text, node);
        break;
      case K.TemplateExpression: {
        const t = node as ts.TemplateExpression;
        onText(t.head.text + t.templateSpans.map((s) => ' ? ' + s.literal.text).join(''), node);
        break;
      }
      case K.PropertyAccessExpression: {
        const p = node as ts.PropertyAccessExpression;
        if (tsApi.isIdentifier(p.expression) && ((p.expression.text === 'module' && p.name.text === 'exports') || p.expression.text === 'exports')) {
          facts.hasCjs = true;
        }
        break;
      }
    }
    tsApi.forEachChild(node, visit);
  };
  visit(raw);

  facts.exports = [...new Set(facts.exports)];
  return facts;
}

function declName(n: MorphNode): string | undefined {
  const anyNode = n as unknown as { getName?: () => string | undefined };
  try {
    const name = anyNode.getName?.();
    return typeof name === 'string' && /^[\w$]+$/.test(name) ? name : undefined;
  } catch {
    return undefined;
  }
}

/** Facts for files that are not parsed with ts-morph. */
export function extractSql(text: string): FileFacts {
  const facts = emptyFacts();
  facts.ddlTables = ddlTables(text);
  return facts;
}

export function extractPrisma(text: string): FileFacts {
  const facts = emptyFacts();
  facts.prismaModels = prismaModels(text);
  return facts;
}
