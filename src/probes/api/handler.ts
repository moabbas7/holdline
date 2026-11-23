/**
 * Finds a route handler's responses (status + JSON body shape) and what it reads from the
 * request, for Next.js app/pages routers and Express/Fastify/Hono-style handlers.
 */
import type { ts as TsNs } from 'ts-morph';
import type { RouteHandler } from '../dependencies/types.js';
import { ShapeReader } from './checker.js';
import { union, UNKNOWN } from './shape.js';
import type { Field, MethodApi, Shape, Status, StatusResponse } from './types.js';

type Ts = typeof TsNs;
type Fn = TsNs.FunctionLikeDeclaration;

export const NEXT_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const MAX_FOLLOW = 3;
const MAX_AT = 3;

interface Variant {
  status: Status;
  body: Shape | null;
  at: string;
  /** Method context for res-style handlers: null = every method. */
  include: Set<string> | null;
  exclude: Set<string>;
}

interface Collected {
  variants: Variant[];
  complete: boolean;
  throws: boolean;
  /** Methods named in req.method comparisons (pages router / app.all). */
  methodsSeen: Set<string>;
}

export interface HandlerResult {
  /** method → API; '*' when the handler serves every method. */
  methods: Record<string, MethodApi>;
  unknown?: string;
}

const shortText = (n: TsNs.Node) => {
  const t = n.getText().replace(/\s+/g, ' ');
  return t.length > 60 ? t.slice(0, 57) + '…' : t;
};

export class HandlerAnalyser {
  private readonly shapes: ShapeReader;
  constructor(
    private readonly ts: Ts,
    private readonly checker: TsNs.TypeChecker,
    private readonly rel: (sf: TsNs.SourceFile) => string,
  ) {
    this.shapes = new ShapeReader(ts, checker);
  }

  analyse(sf: TsNs.SourceFile, h: RouteHandler, params: string[]): HandlerResult {
    const fastify = /\bfastify\b/.test(sf.text);
    if (h.kind === 'next-app') {
      const methods: Record<string, MethodApi> = {};
      const exported = this.exportedValues(sf);
      for (const m of NEXT_METHODS) {
        const v = exported.get(m);
        if (!v) continue;
        const fns = this.handlerFunctions(v, 0);
        if (fns.length === 0) {
          methods[m] = { responses: [], complete: false, unknown: `the ${m} handler is not a function holdline can read (${shortText(v)})`, request: { query: [], params } };
          continue;
        }
        const col = this.collectReturns(fns, 'next');
        methods[m] = this.toMethod(col, fns, params, m);
      }
      if (Object.keys(methods).length === 0) {
        return { methods: {}, unknown: exported.size === 0 ? 'no exported GET/POST/… handlers found' : 'exports are not analysable route handlers' };
      }
      return { methods };
    }
    if (h.kind === 'next-pages') {
      const def = this.exportedValues(sf).get('default');
      const fns = def ? this.handlerFunctions(def, 0) : [];
      if (fns.length === 0) return { methods: {}, unknown: def ? 'the default export is not an analysable function' : 'no default export' };
      return this.resStyle(fns, params, null);
    }
    // Express / Fastify / Hono: the call at the definition line.
    const call = this.routeDefCall(sf, h);
    if (!call) return { methods: {}, unknown: 'route definition not found' };
    const last = call.arguments[call.arguments.length - 1]!;
    const fns = this.handlerFunctions(last, 0);
    if (fns.length === 0) return { methods: {}, unknown: 'the handler is not an analysable function' };
    const method = h.method && h.method !== '*' ? h.method : null;
    const fn = fns[0]!;
    const usesReturn = this.returnsValues(fn);
    if (usesReturn && !this.resParam(fn, fastify)) {
      // Hono-style `(c) => c.json(…)`, or Fastify returning a value.
      const col = this.collectReturns(fns, fastify ? 'fastify' : 'hono');
      return { methods: { [method ?? '*']: this.toMethod(col, fns, params, method ?? '*') } };
    }
    return this.resStyle(fns, params, method, fastify);
  }

  // --- Locating handler functions ------------------------------------------------------

  /** Exported value declarations/initialisers by export name. */
  private exportedValues(sf: TsNs.SourceFile): Map<string, TsNs.Node> {
    const ts = this.ts;
    const out = new Map<string, TsNs.Node>();
    const modSym = this.checker.getSymbolAtLocation(sf);
    if (!modSym) return out;
    for (let sym of this.checker.getExportsOfModule(modSym)) {
      const name = sym.getName();
      if (sym.flags & ts.SymbolFlags.Alias) {
        try {
          sym = this.checker.getAliasedSymbol(sym);
        } catch {
          continue;
        }
      }
      const decl = sym.valueDeclaration ?? sym.declarations?.[0];
      if (!decl) continue;
      if (ts.isVariableDeclaration(decl)) {
        if (decl.initializer) out.set(name, decl.initializer);
      } else if (ts.isExportAssignment(decl)) out.set(name, decl.expression);
      else out.set(name, decl);
    }
    return out;
  }

  /** The function(s) that handle a request, given an export value or handler argument. */
  private handlerFunctions(n: TsNs.Node, depth: number): Fn[] {
    const ts = this.ts;
    if (depth > MAX_FOLLOW) return [];
    if (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isSatisfiesExpression(n)) return this.handlerFunctions(n.expression, depth);
    if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n)) {
      return n.body ? [n] : [];
    }
    if (ts.isIdentifier(n) || ts.isPropertyAccessExpression(n)) {
      const decl = this.declOf(n);
      if (!decl) return [];
      if (ts.isVariableDeclaration(decl)) return decl.initializer ? this.handlerFunctions(decl.initializer, depth + 1) : [];
      return this.handlerFunctions(decl, depth + 1);
    }
    if (ts.isCallExpression(n)) {
      // A wrapper: withAuth(async (req) => …), compose(a, b)(handler) …
      const fns: Fn[] = [];
      for (const a of n.arguments) {
        if (ts.isFunctionExpression(a) || ts.isArrowFunction(a)) fns.push(a);
        else if (ts.isCallExpression(a)) fns.push(...this.handlerFunctions(a, depth + 1));
      }
      if (fns.length === 0) {
        for (const a of n.arguments) if (ts.isIdentifier(a)) fns.push(...this.handlerFunctions(a, depth + 1));
      }
      if (fns.length === 0 && ts.isCallExpression(n.expression)) fns.push(...this.handlerFunctions(n.expression, depth + 1));
      return fns.slice(0, 1);
    }
    return [];
  }

  private declOf(n: TsNs.Node): TsNs.Declaration | undefined {
    const ts = this.ts;
    let sym = this.checker.getSymbolAtLocation(n);
    if (!sym) return undefined;
    if (sym.flags & ts.SymbolFlags.Alias) {
      try {
        sym = this.checker.getAliasedSymbol(sym);
      } catch {
        return undefined;
      }
    }
    return sym.valueDeclaration ?? sym.declarations?.[0];
  }

  private routeDefCall(sf: TsNs.SourceFile, h: RouteHandler): TsNs.CallExpression | null {
    const ts = this.ts;
    let found: TsNs.CallExpression | null = null;
    const want = h.method === '*' ? 'all' : h.method?.toLowerCase();
    const visit = (n: TsNs.Node) => {
      if (found) return;
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.arguments.length >= 2) {
        const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
        if (line === h.line && n.expression.name.text.toLowerCase() === want) {
          found = n;
          return;
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return found;
  }

  private resParam(fn: Fn, fastify: boolean): string | null {
    const p = fn.parameters[1];
    if (!p || !this.ts.isIdentifier(p.name)) return null;
    if (fastify && !/reply|res/i.test(p.name.text)) return null;
    return p.name.text;
  }

  /** Does the function return values (not just `return;` or `return res.json()`)? */
  private returnsValues(fn: Fn): boolean {
    const ts = this.ts;
    if (fn.body && !ts.isBlock(fn.body)) return true;
    let yes = false;
    this.ownReturns(fn, (r) => {
      if (r.expression) yes = true;
    });
    return yes;
  }

  private ownReturns(fn: Fn, cb: (r: TsNs.ReturnStatement) => void, onThrow?: () => void): void {
    const ts = this.ts;
    const visit = (n: TsNs.Node) => {
      if (n !== fn && (ts.isFunctionLike(n) || ts.isClassLike(n))) return;
      if (ts.isReturnStatement(n)) cb(n);
      else if (ts.isThrowStatement(n)) onThrow?.();
      ts.forEachChild(n, visit);
    };
    if (fn.body) visit(fn.body);
  }

  private at(n: TsNs.Node): string {
    const sf = n.getSourceFile();
    return `${this.rel(sf)}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  }

  // --- Return-style handlers (Next app router, Hono, Fastify) ----------------------------

  private collectReturns(fns: Fn[], style: 'next' | 'hono' | 'fastify', depth = 0, col?: Collected): Collected {
    const ts = this.ts;
    const out: Collected = col ?? { variants: [], complete: true, throws: false, methodsSeen: new Set() };
    for (const fn of fns) {
      if (!fn.body) {
        out.complete = false;
        continue;
      }
      const exprs: TsNs.Expression[] = [];
      if (!ts.isBlock(fn.body)) exprs.push(fn.body);
      else
        this.ownReturns(
          fn,
          (r) => r.expression && exprs.push(r.expression),
          () => (out.throws = true),
        );
      for (const e of exprs) this.returned(e, style, depth, out);
    }
    return out;
  }

  private returned(e: TsNs.Expression, style: 'next' | 'hono' | 'fastify', depth: number, out: Collected): void {
    const ts = this.ts;
    const add = (status: Status, body: Shape | null, n: TsNs.Node) => {
      out.variants.push({ status, body, at: this.at(n), include: null, exclude: new Set() });
      if (status === 'unknown') out.complete = false;
    };
    if (ts.isParenthesizedExpression(e) || ts.isAwaitExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression(e)) {
      return this.returned(e.expression, style, depth, out);
    }
    if (ts.isConditionalExpression(e)) {
      this.returned(e.whenTrue, style, depth, out);
      this.returned(e.whenFalse, style, depth, out);
      return;
    }
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
      const name = e.expression.name.text;
      const recv = e.expression.expression;
      const recvText = ts.isIdentifier(recv) ? recv.text : ts.isPropertyAccessExpression(recv) ? recv.name.text : '';
      // NextResponse.json / Response.json
      if (name === 'json' && /^(NextResponse|Response)$/.test(recvText)) {
        const body = e.arguments[0] ? this.bodyShape(e.arguments[0], e) : ({ k: 'null' } as Shape);
        add(this.initStatus(e.arguments[1], 200), body, e);
        return;
      }
      if (name === 'redirect' && /^(NextResponse|Response)$/.test(recvText)) {
        const s = e.arguments[1];
        add(s ? (ts.isObjectLiteralExpression(s) ? this.initStatus(s, recvText === 'Response' ? 302 : 307) : this.statusOf(s)) : recvText === 'Response' ? 302 : 307, null, e);
        return;
      }
      if ((name === 'rewrite' || name === 'next') && recvText === 'NextResponse') return;
      // Hono context
      if (style === 'hono' || style === 'fastify' || this.looksLikeHonoContext(recv)) {
        if (name === 'json') {
          add(e.arguments[1] ? this.statusOf(e.arguments[1]) : 200, e.arguments[0] ? this.bodyShape(e.arguments[0], e) : null, e);
          return;
        }
        if (name === 'text' || name === 'html' || name === 'body') {
          add(e.arguments[1] ? this.statusOf(e.arguments[1]) : 200, null, e);
          return;
        }
        if (name === 'redirect') {
          add(e.arguments[1] ? this.statusOf(e.arguments[1]) : 302, null, e);
          return;
        }
        if (name === 'notFound') {
          add(404, null, e);
          return;
        }
        if (name === 'send' && style === 'fastify') {
          add(this.chainStatus(recv) ?? 200, e.arguments[0] ? this.sendShape(e.arguments[0]) : null, e);
          return;
        }
      }
    }
    if (ts.isNewExpression(e) && ts.isIdentifier(e.expression) && /^(NextResponse|Response)$/.test(e.expression.text)) {
      const a0 = e.arguments?.[0];
      let body: Shape | null = null;
      if (a0 && ts.isCallExpression(a0) && ts.isPropertyAccessExpression(a0.expression) && a0.expression.getText() === 'JSON.stringify' && a0.arguments[0]) {
        body = this.bodyShape(a0.arguments[0], e);
      }
      add(this.initStatus(e.arguments?.[1], 200), body, e);
      return;
    }
    if (style === 'fastify' && (ts.isObjectLiteralExpression(e) || ts.isArrayLiteralExpression(e))) {
      add(200, this.shapes.exprShape(e), e);
      return;
    }
    if (ts.isCallExpression(e)) {
      // A helper that builds the response: follow it.
      if (depth < MAX_FOLLOW) {
        const fns = this.handlerFunctions(e.expression, MAX_FOLLOW - 1);
        const fn = fns[0];
        if (fn && fn.body) {
          const before = out.variants.length;
          this.collectReturns([fn], style, depth + 1, out);
          if (out.variants.length > before) return;
        }
      }
      return this.fromType(e, out, add);
    }
    if (ts.isIdentifier(e)) {
      const decl = this.declOf(e);
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer && depth < MAX_FOLLOW && ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) {
        return this.returned(decl.initializer, style, depth + 1, out);
      }
      return this.fromType(e, out, add);
    }
    if (style === 'fastify') {
      add(200, this.shapes.exprShape(e), e);
      return;
    }
    if (e.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(e) && e.text === 'undefined')) return;
    out.complete = false;
  }

  /** A response produced by something we can't read: use its NextResponse<T> type if any. */
  private fromType(e: TsNs.Expression, out: Collected, add: (s: Status, b: Shape | null, n: TsNs.Node) => void): void {
    let t = this.checker.getTypeAtLocation(e);
    t = this.checker.getAwaitedType(t) ?? t;
    out.complete = false; // the status of a response built elsewhere is unknown
    for (const m of t.isUnion() ? t.types : [t]) this.responseTypeArg(m, e, add);
  }

  private responseTypeArg(t: TsNs.Type, e: TsNs.Node, add: (s: Status, b: Shape | null, n: TsNs.Node) => void): boolean {
    const name = t.getSymbol()?.getName();
    if (name !== 'NextResponse') return false;
    const args = this.checker.getTypeArguments(t as TsNs.TypeReference);
    const arg = args[0] ?? (t as TsNs.TypeReference).aliasTypeArguments?.[0];
    if (!arg || this.shapes.isOpaque(arg)) {
      add('unknown', UNKNOWN('response built elsewhere'), e);
      return true;
    }
    add('unknown', this.shapes.typeShape(arg, e), e);
    return true;
  }

  private looksLikeHonoContext(recv: TsNs.Expression): boolean {
    return this.ts.isIdentifier(recv) && (recv.text === 'c' || recv.text === 'ctx' || recv.text === 'context');
  }

  // --- res-style handlers (pages router, Express, Fastify reply) -------------------------

  private resStyle(fns: Fn[], params: string[], fixedMethod: string | null, fastify = false): HandlerResult {
    const ts = this.ts;
    const fn = fns[0]!;
    const resName = this.resParam(fn, fastify);
    const reqName = fn.parameters[0] && ts.isIdentifier(fn.parameters[0].name) ? fn.parameters[0].name.text : null;
    const col: Collected = { variants: [], complete: true, throws: false, methodsSeen: new Set() };
    if (!resName) return { methods: {}, unknown: 'no response parameter' };
    const declared = this.declaredResBody(fn);
    const methodVars = new Set<string>();

    const isMethodExpr = (x: TsNs.Expression): boolean => {
      while (ts.isPropertyAccessExpression(x) && /^(toUpperCase|toLowerCase)$/.test(x.name.text)) x = x.expression;
      if (ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression)) return isMethodExpr(x.expression.expression);
      if (ts.isPropertyAccessExpression(x) && x.name.text === 'method' && ts.isIdentifier(x.expression) && x.expression.text === reqName) return true;
      return ts.isIdentifier(x) && methodVars.has(x.text);
    };
    /** Methods a condition checks for: positive (===) or negative (!==). */
    const condMethods = (c: TsNs.Expression): { pos: string[]; neg: string[] } | null => {
      if (ts.isParenthesizedExpression(c)) return condMethods(c.expression);
      if (ts.isBinaryExpression(c)) {
        const op = c.operatorToken.kind;
        const K = ts.SyntaxKind;
        if (op === K.BarBarToken || op === K.AmpersandAmpersandToken) {
          const l = condMethods(c.left);
          const r = condMethods(c.right);
          if (!l || !r) return null;
          if (op === K.BarBarToken && l.neg.length === 0 && r.neg.length === 0) return { pos: [...l.pos, ...r.pos], neg: [] };
          if (op === K.AmpersandAmpersandToken && l.pos.length === 0 && r.pos.length === 0) return { pos: [], neg: [...l.neg, ...r.neg] };
          return null;
        }
        const eq = op === K.EqualsEqualsEqualsToken || op === K.EqualsEqualsToken;
        const ne = op === K.ExclamationEqualsEqualsToken || op === K.ExclamationEqualsToken;
        if (!eq && !ne) return null;
        const [m, lit] = isMethodExpr(c.left) ? [c.left, c.right] : isMethodExpr(c.right) ? [c.right, c.left] : [null, null];
        if (!m || !lit || !ts.isStringLiteralLike(lit)) return null;
        const v = lit.text.toUpperCase();
        return eq ? { pos: [v], neg: [] } : { pos: [], neg: [v] };
      }
      return null;
    };
    const alwaysExits = (s: TsNs.Statement): boolean => {
      if (ts.isReturnStatement(s) || ts.isThrowStatement(s)) return true;
      if (ts.isBlock(s)) return s.statements.some(alwaysExits);
      if (ts.isIfStatement(s)) return !!s.elseStatement && alwaysExits(s.thenStatement) && alwaysExits(s.elseStatement);
      return false;
    };

    type Ctx = { include: Set<string> | null; exclude: Set<string> };
    const narrow = (ctx: Ctx, pos: string[]): Ctx => {
      const inc = new Set(pos.filter((m) => !ctx.exclude.has(m) && (!ctx.include || ctx.include.has(m))));
      return { include: inc, exclude: ctx.exclude };
    };
    const without = (ctx: Ctx, neg: string[]): Ctx => ({ include: ctx.include, exclude: new Set([...ctx.exclude, ...neg]) });

    const visit = (n: TsNs.Node, ctx: Ctx): void => {
      if (ts.isVariableDeclaration(n) && n.initializer) {
        // const { method } = req  /  const method = req.method
        if (ts.isObjectBindingPattern(n.name) && ts.isIdentifier(n.initializer) && n.initializer.text === reqName) {
          for (const el of n.name.elements) {
            const prop = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : ts.isIdentifier(el.name) ? el.name.text : '';
            if (prop === 'method' && ts.isIdentifier(el.name)) methodVars.add(el.name.text);
          }
        } else if (ts.isIdentifier(n.name) && isMethodExpr(n.initializer)) methodVars.add(n.name.text);
      }
      if (ts.isIfStatement(n)) {
        const cm = condMethods(n.expression);
        if (cm) {
          cm.pos.forEach((m) => col.methodsSeen.add(m));
          cm.neg.forEach((m) => col.methodsSeen.add(m));
          const [thenCtx, elseCtx] = cm.pos.length ? [narrow(ctx, cm.pos), without(ctx, cm.pos)] : [without(ctx, cm.neg), narrow(ctx, cm.neg)];
          visit(n.thenStatement, thenCtx);
          if (n.elseStatement) visit(n.elseStatement, elseCtx);
          return;
        }
      }
      if (ts.isBlock(n)) {
        let cur = ctx;
        for (const s of n.statements) {
          visit(s, cur);
          // `if (req.method !== 'POST') return …;` — the rest of the block is POST only.
          if (ts.isIfStatement(s) && alwaysExits(s.thenStatement)) {
            const cm = condMethods(s.expression);
            if (cm) cur = cm.pos.length ? without(cur, cm.pos) : narrow(cur, cm.neg);
          }
        }
        return;
      }
      if (ts.isSwitchStatement(n) && isMethodExpr(n.expression)) {
        const named: string[] = [];
        let pending: string[] = [];
        for (const clause of n.caseBlock.clauses) {
          if (ts.isCaseClause(clause) && ts.isStringLiteralLike(clause.expression)) {
            const m = clause.expression.text.toUpperCase();
            named.push(m);
            col.methodsSeen.add(m);
            pending.push(m);
          }
          if (clause.statements.length === 0) continue;
          const sub: Ctx = ts.isDefaultClause(clause) ? without(ctx, named) : narrow(ctx, pending);
          for (const s of clause.statements) visit(s, sub);
          pending = [];
        }
        return;
      }
      if (ts.isCallExpression(n)) {
        const v = this.resCall(n, resName, declared);
        if (v) {
          if (v.status === 'unknown') col.complete = false;
          col.variants.push({ ...v, include: ctx.include, exclude: ctx.exclude });
          return; // don't revisit the inner res.status(n) call
        }
        // res handed to a helper: it may respond.
        if (n.arguments.some((a) => ts.isIdentifier(a) && a.text === resName) && !ts.isPropertyAccessExpression(n.expression)) col.complete = false;
      }
      if (ts.isThrowStatement(n)) col.throws = true;
      ts.forEachChild(n, (c) => visit(c, ctx));
    };
    if (fn.body) visit(fn.body, { include: fixedMethod ? new Set([fixedMethod]) : null, exclude: new Set() });

    const methods: Record<string, MethodApi> = {};
    const names = fixedMethod ? [fixedMethod] : col.methodsSeen.size ? [...col.methodsSeen].sort() : ['*'];
    for (const m of names) {
      const vs = col.variants.filter((v) => (m === '*' || !v.include || v.include.has(m)) && (m === '*' || !v.exclude.has(m)));
      // A method only seen in `!==` guards with no responses of its own is still handled.
      methods[m] = this.toMethod({ ...col, variants: vs }, fns, params, m, reqName);
    }
    return { methods };
  }

  /** res.json(x), res.status(n).json(x), res.send(x), res.sendStatus(n), res.end(), res.redirect(), reply.code(n).send(x). */
  private resCall(n: TsNs.CallExpression, resName: string, declared: Shape | null): { status: Status; body: Shape | null; at: string } | null {
    const ts = this.ts;
    if (!ts.isPropertyAccessExpression(n.expression)) return null;
    const name = n.expression.name.text;
    const recv = n.expression.expression;
    if (!this.rootIs(recv, resName)) return null;
    const status = this.chainStatus(recv);
    if (status === undefined) return null;
    const at = this.at(n);
    switch (name) {
      case 'json': {
        let body = n.arguments[0] ? this.bodyShape(n.arguments[0], n) : ({ k: 'null' } as Shape);
        if (body.k === 'unknown' && declared) body = declared;
        return { status: status ?? 200, body, at };
      }
      case 'send': {
        const a = n.arguments[0];
        let body = a ? this.sendShape(a) : null;
        if (body && body.k === 'unknown' && declared) body = declared;
        return { status: status ?? 200, body, at };
      }
      case 'end':
        return { status: status ?? 200, body: null, at };
      case 'sendStatus':
        return { status: n.arguments[0] ? this.statusOf(n.arguments[0]) : 'unknown', body: null, at };
      case 'redirect': {
        const a0 = n.arguments[0];
        return { status: a0 && n.arguments.length > 1 ? this.statusOf(a0) : 302, body: null, at };
      }
      default:
        return null;
    }
  }

  /** Is `e` the identifier `name`, possibly through .status()/.code()/.setHeader() chains? */
  private rootIs(e: TsNs.Expression, name: string): boolean {
    const ts = this.ts;
    while (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) e = e.expression.expression;
    return ts.isIdentifier(e) && e.text === name;
  }

  /** Status from a `.status(n)` / `.code(n)` chain: null when none, 'unknown' when dynamic, undefined when not a res chain. */
  private chainStatus(e: TsNs.Expression): Status | null | undefined {
    const ts = this.ts;
    let status: Status | null = null;
    while (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
      const m = e.expression.name.text;
      if ((m === 'status' || m === 'code') && e.arguments[0]) status ??= this.statusOf(e.arguments[0]);
      else if (!/^(set|setHeader|header|headers|type|cookie|clearCookie|append|vary|location|links|attachment)$/.test(m)) return undefined;
      e = e.expression.expression;
    }
    return status;
  }

  /** `send(x)`: objects/arrays are JSON; strings/buffers are not. */
  private sendShape(a: TsNs.Expression): Shape | null {
    const ts = this.ts;
    if (ts.isStringLiteralLike(a) || ts.isTemplateExpression(a)) return null;
    const s = this.shapes.exprShape(a);
    if (s.k === 'string' || s.k === 'number' || s.k === 'boolean') return null;
    return s;
  }

  /** NextApiResponse<T> / express Response<T>: the declared body type, when given. */
  private declaredResBody(fn: Fn): Shape | null {
    const p = fn.parameters[1];
    if (!p) return null;
    const t = this.checker.getTypeAtLocation(p);
    const args = t.aliasTypeArguments ?? (t.flags & this.ts.TypeFlags.Object ? this.checker.getTypeArguments(t as TsNs.TypeReference) : []);
    const a = args?.[0];
    if (!a || this.shapes.isOpaque(a)) return null;
    const s = this.shapes.typeShape(a, p);
    return s.k === 'unknown' ? null : s;
  }

  // --- Status codes and bodies ----------------------------------------------------------

  private statusOf(e: TsNs.Expression): Status {
    const ts = this.ts;
    if (ts.isNumericLiteral(e)) return Number(e.text);
    const t = this.checker.getTypeAtLocation(e);
    if (t.isNumberLiteral()) return t.value;
    if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) {
      const d = this.declOf(e);
      if (d && (ts.isVariableDeclaration(d) || ts.isPropertyAssignment(d) || ts.isEnumMember(d)) && d.initializer && ts.isNumericLiteral(d.initializer)) {
        return Number(d.initializer.text);
      }
    }
    return 'unknown';
  }

  /** Status from a ResponseInit (`{ status: 404 }`); `dflt` when it has none. */
  private initStatus(init: TsNs.Expression | undefined, dflt: number): Status {
    const ts = this.ts;
    if (!init) return dflt;
    let obj: TsNs.Expression = init;
    if (ts.isIdentifier(init)) {
      const d = this.declOf(init);
      if (d && ts.isVariableDeclaration(d) && d.initializer) obj = d.initializer;
    }
    if (!ts.isObjectLiteralExpression(obj)) {
      const t = this.checker.getTypeAtLocation(init);
      const st = t.getProperty('status');
      if (!st) return dflt;
      const stt = this.checker.getTypeOfSymbolAtLocation(st, init);
      return stt.isNumberLiteral() ? stt.value : 'unknown';
    }
    let status: Status = dflt;
    for (const p of obj.properties) {
      if (ts.isSpreadAssignment(p)) {
        const t = this.checker.getTypeAtLocation(p.expression);
        if (t.getProperty('status')) status = 'unknown';
      } else if (p.name && ts.isIdentifier(p.name) && p.name.text === 'status') {
        if (ts.isPropertyAssignment(p)) status = this.statusOf(p.initializer);
        else if (ts.isShorthandPropertyAssignment(p)) status = this.statusOf(p.name);
      }
    }
    return status;
  }

  private bodyShape(e: TsNs.Expression, call: TsNs.Node): Shape {
    const s = this.shapes.exprShape(e);
    if (s.k !== 'unknown') return s;
    // NextResponse.json<T>(x): use T.
    if (this.ts.isCallExpression(call) && call.typeArguments?.[0]) {
      const t = this.checker.getTypeFromTypeNode(call.typeArguments[0]);
      if (!this.shapes.isOpaque(t)) return this.shapes.typeShape(t, call);
    }
    return s;
  }

  // --- Merging into a MethodApi ----------------------------------------------------------

  private toMethod(col: Collected, fns: Fn[], params: string[], method: string, reqName?: string | null): MethodApi {
    const by = new Map<string, { status: Status; bodies: (Shape | null)[]; at: string[] }>();
    for (const v of col.variants) {
      const k = String(v.status);
      let e = by.get(k);
      if (!e) by.set(k, (e = { status: v.status, bodies: [], at: [] }));
      e.bodies.push(v.body);
      if (e.at.length < MAX_AT && !e.at.includes(v.at)) e.at.push(v.at);
    }
    const responses: StatusResponse[] = [...by.values()]
      .map((e) => {
        const json = e.bodies.filter((b): b is Shape => b !== null);
        return { status: e.status, body: json.length ? union(json) : null, at: e.at };
      })
      .sort((a, b) => (a.status === 'unknown' ? 1 : b.status === 'unknown' ? -1 : a.status - b.status));
    const fn = fns[0];
    const request = fn ? this.requestOf(fn, params, method, reqName ?? undefined) : { query: [], params };
    return { responses, complete: col.complete, ...(col.throws ? { throws: true as const } : {}), request };
  }

  // --- Request shape ---------------------------------------------------------------------

  private requestOf(fn: Fn, params: string[], method: string, reqNameIn?: string): MethodApi['request'] {
    const ts = this.ts;
    const p0 = fn.parameters[0];
    const reqName = reqNameIn ?? (p0 && ts.isIdentifier(p0.name) ? p0.name.text : null);
    // Wrapper handlers often destructure ({ req, searchParams }) => …
    const names = new Set<string>();
    if (reqName) names.add(reqName);
    if (p0 && ts.isObjectBindingPattern(p0.name)) {
      for (const el of p0.name.elements) if (ts.isIdentifier(el.name) && /^(req|request)$/.test(el.name.text)) names.add(el.name.text);
    }
    const query = new Set<string>();
    const bodyFields: Record<string, Field> = {};
    let bodyTyped: Shape | null = null;
    let readsBody = false;
    const bodyVars = new Set<string>();

    const isReq = (x: TsNs.Expression) => ts.isIdentifier(x) && names.has(x.text);
    const isBodySource = (x: TsNs.Expression): boolean => {
      while (ts.isAwaitExpression(x) || ts.isParenthesizedExpression(x)) x = x.expression;
      if (ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression)) {
        const n = x.expression.name.text;
        const r = x.expression.expression;
        if (n === 'json' && isReq(r)) return true; // req.json()
        if ((n === 'json' || n === 'valid') && ts.isPropertyAccessExpression(r) && r.name.text === 'req') return true; // c.req.json()
      }
      if (ts.isPropertyAccessExpression(x) && x.name.text === 'body' && isReq(x.expression)) return true; // req.body
      if (ts.isCallExpression(x) && x.arguments.some((a) => isReq(a))) {
        const callee = x.expression;
        const n = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
        if (/body|json/i.test(n)) return true; // parseRequestBody(req)
      }
      return false;
    };
    const schemaInput = (call: TsNs.CallExpression): Shape | null => {
      if (!ts.isPropertyAccessExpression(call.expression) || !/^(parse|parseAsync|safeParse|safeParseAsync)$/.test(call.expression.name.text)) return null;
      const st = this.checker.getTypeAtLocation(call.expression.expression);
      let input = st.getProperty('_input');
      let holder: TsNs.Type = st;
      if (!input) {
        const zod = st.getProperty('_zod');
        if (zod) {
          holder = this.checker.getTypeOfSymbolAtLocation(zod, call);
          input = holder.getProperty('input');
        }
      }
      if (!input) return null;
      const it = this.checker.getTypeOfSymbolAtLocation(input, call);
      if (this.shapes.isOpaque(it)) return null;
      return this.shapes.typeShape(it, call);
    };
    const noteTyped = (x: TsNs.Node) => {
      const t = this.checker.getTypeAtLocation(x);
      if (this.shapes.isOpaque(t)) return;
      const s = this.shapes.typeShape(t, x);
      if (s.k === 'object') bodyTyped = s;
    };
    const destructure = (pat: TsNs.ObjectBindingPattern) => {
      for (const el of pat.elements) {
        if (el.dotDotDotToken) continue;
        const key = el.propertyName ?? el.name;
        if (ts.isIdentifier(key) || ts.isStringLiteral(key)) {
          bodyFields[key.text] ??= { shape: UNKNOWN('untyped'), optional: el.initializer ? true : 'unknown' };
        }
      }
    };

    const visit = (n: TsNs.Node) => {
      // Query parameters.
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
        const m = n.expression.name.text;
        const a0 = n.arguments[0];
        const r = n.expression.expression;
        if (/^(get|getAll|has)$/.test(m) && a0 && ts.isStringLiteralLike(a0) && /searchParams|params$/i.test(r.getText())) query.add(a0.text);
        if ((m === 'query' || m === 'queries') && a0 && ts.isStringLiteralLike(a0) && ts.isPropertyAccessExpression(r) && r.name.text === 'req') query.add(a0.text);
      }
      if (ts.isPropertyAccessExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'query' && isReq(n.expression.expression)) {
        query.add(n.name.text);
      }
      if (ts.isVariableDeclaration(n) && n.initializer) {
        let init = n.initializer;
        while (ts.isAwaitExpression(init) || ts.isParenthesizedExpression(init)) init = init.expression;
        if (ts.isObjectBindingPattern(n.name) && ts.isPropertyAccessExpression(init) && init.name.text === 'query' && isReq(init.expression)) {
          for (const el of n.name.elements) {
            const key = el.propertyName ?? el.name;
            if (ts.isIdentifier(key)) query.add(key.text);
          }
        }
        // Body.
        const src = isBodySource(init) ? init : ts.isAsExpression(init) && isBodySource(init.expression) ? init.expression : null;
        if (src) {
          readsBody = true;
          if (n.type || ts.isAsExpression(init)) noteTyped(n.type ? n.name : init);
          else noteTyped(src);
          if (ts.isIdentifier(n.name)) bodyVars.add(n.name.text);
          else if (ts.isObjectBindingPattern(n.name) && !bodyTyped) destructure(n.name);
        } else if (ts.isIdentifier(init) && bodyVars.has(init.text) && ts.isObjectBindingPattern(n.name)) {
          destructure(n.name);
        }
      }
      if (ts.isCallExpression(n)) {
        const arg = n.arguments[0];
        if (arg && (isBodySource(arg) || (ts.isIdentifier(arg) && bodyVars.has(arg.text)))) {
          // The body is read (even when the schema's type can't be resolved: then it's unknown).
          if (isBodySource(arg)) readsBody = true;
          const s = schemaInput(n);
          if (s) {
            readsBody = true;
            if (s.k === 'object') bodyTyped = s;
          }
        }
      }
      if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && bodyVars.has(n.expression.text)) {
        bodyFields[n.name.text] ??= { shape: UNKNOWN('untyped'), optional: 'unknown' };
      }
      if (ts.isPropertyAccessExpression(n) && n.name.text !== 'body' && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'body' && isReq(n.expression.expression)) {
        readsBody = true;
        bodyFields[n.name.text] ??= { shape: UNKNOWN('untyped'), optional: 'unknown' };
      }
      ts.forEachChild(n, visit);
    };
    if (fn.body) visit(fn.body);
    for (const p of params) query.delete(p);
    const req: MethodApi['request'] = { query: [...query].sort(), params };
    if (method === 'GET' || method === 'HEAD') return req;
    if (bodyTyped) req.body = bodyTyped;
    else if (Object.keys(bodyFields).length) req.body = { k: 'object', fields: Object.fromEntries(Object.entries(bodyFields).sort(([a], [b]) => a.localeCompare(b))), open: true };
    else if (readsBody && method !== 'GET') req.body = UNKNOWN('untyped body');
    return req;
  }
}
