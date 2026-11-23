/**
 * Lines in a calling file that read a given field of an API response: follows the JSON from
 * the call (`await res.json()`, `.then(r => r.json())`, `const { data } = useSWR(…)`, axios
 * `data`) through variables, destructuring and array callbacks (`items.map(i => i.x)`).
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ts as TsNs } from 'ts-morph';
import { decodeText } from '../dependencies/files.js';

type Ts = typeof TsNs;

export interface FieldRef {
  file: string;
  line: number;
  text: string;
  /** false: the JSON couldn't be traced from the call; the line just mentions the field name. */
  exact: boolean;
}

type Kind = 'response' | 'json' | 'axios' | 'swr';

const ARRAY_CALLBACKS = /^(map|forEach|filter|find|findLast|some|every|flatMap|sort|findIndex)$/;
const norm = (p: string[]) => p.filter((s) => s !== '[]');

export async function fieldRefs(
  root: string,
  calls: { file: string; line: number }[],
  field: string[],
  opts: { limit?: number } = {},
): Promise<FieldRef[]> {
  if (field.length === 0 || calls.length === 0) return [];
  const ts = (await import('ts-morph')).ts;
  const out: FieldRef[] = [];
  const byFile = new Map<string, number[]>();
  for (const c of calls) (byFile.get(c.file) ?? byFile.set(c.file, []).get(c.file)!).push(c.line);
  for (const [file, lines] of byFile) {
    let text: string;
    try {
      text = decodeText(await readFile(path.join(root, file)));
    } catch {
      continue;
    }
    const last = field.filter((s) => s !== '[]').at(-1);
    if (!last || !text.includes(last)) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, /\.[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const found = new Map<number, FieldRef>();
    let traced = false;
    for (const line of lines) {
      const r = new Tracer(ts, sf);
      if (r.fromCallAt(line)) traced = true;
      for (const a of r.accesses) {
        const p = norm(a.path);
        const want = norm(field);
        if (p.length >= want.length && want.every((s, i) => p[i] === s) && !found.has(a.line)) {
          found.set(a.line, { file, line: a.line, text: a.text, exact: true });
        }
      }
    }
    if (!traced) {
      // Couldn't follow the JSON: lines that mention the field name.
      const visit = (n: TsNs.Node) => {
        const hit =
          (ts.isPropertyAccessExpression(n) && n.name.text === last) ||
          (ts.isBindingElement(n) && ((n.propertyName && ts.isIdentifier(n.propertyName) && n.propertyName.text === last) || (!n.propertyName && ts.isIdentifier(n.name) && n.name.text === last)));
        if (hit) {
          const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
          if (!found.has(line)) found.set(line, { file, line, text: snippet(n, sf), exact: false });
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    out.push(...[...found.values()].sort((a, b) => a.line - b.line));
    if (opts.limit && out.length >= opts.limit) break;
  }
  return opts.limit ? out.slice(0, opts.limit) : out;
}

function snippet(n: TsNs.Node, sf: TsNs.SourceFile): string {
  const t = n.getText(sf).replace(/\s+/g, ' ');
  return t.length > 80 ? t.slice(0, 77) + '…' : t;
}

class Tracer {
  accesses: { path: string[]; line: number; text: string }[] = [];
  private seen = new Set<TsNs.Node>();
  constructor(
    private ts: Ts,
    private sf: TsNs.SourceFile,
  ) {}

  private lineOf(n: TsNs.Node) {
    return this.sf.getLineAndCharacterOfPosition(n.getStart(this.sf)).line + 1;
  }

  /** Start from the HTTP call on `line`. Returns whether any JSON value was found. */
  fromCallAt(line: number): boolean {
    const ts = this.ts;
    let call: { node: TsNs.CallExpression; kind: Kind } | null = null;
    const visit = (n: TsNs.Node) => {
      if (call) return;
      if (ts.isCallExpression(n) && this.lineOf(n) === line) {
        const k = this.callKind(n);
        if (k) {
          call = { node: n, kind: k };
          return;
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(this.sf);
    if (!call) return false;
    const before = this.accesses.length;
    const found = this.flow((call as { node: TsNs.CallExpression }).node, (call as { kind: Kind }).kind, []);
    return found || this.accesses.length > before;
  }

  private callKind(n: TsNs.CallExpression): Kind | null {
    const ts = this.ts;
    const c = n.expression;
    const name = ts.isIdentifier(c) ? c.text : ts.isPropertyAccessExpression(c) ? c.name.text : '';
    const recv = ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) ? c.expression.text : '';
    if (name === 'fetch') return 'response';
    if (/^useSWR/.test(name) || name === 'useQuery') return 'swr';
    if (name === 'axios' || recv === 'axios' || /^(get|post|put|patch|delete|request)$/.test(name)) return 'axios';
    return null;
  }

  /**
   * `e` evaluates to a value of `kind` (a JSON value at `path` when kind is 'json'). Follow it
   * upward through awaits, .then(), .json(), .data and into variables. Returns true when a
   * JSON value was reached.
   */
  private flow(e: TsNs.Expression, kind: Kind, path: string[]): boolean {
    const ts = this.ts;
    if (this.seen.has(e)) return false;
    this.seen.add(e);
    const p = e.parent;
    if (!p) return false;
    if (ts.isAwaitExpression(p) || ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isNonNullExpression(p) || ts.isSatisfiesExpression(p)) {
      return this.flow(p as TsNs.Expression, kind, path);
    }
    if (kind === 'json') {
      this.access(e, path);
      return true;
    }
    if (ts.isPropertyAccessExpression(p) && p.expression === e) {
      const name = p.name.text;
      const call = p.parent && ts.isCallExpression(p.parent) && p.parent.expression === p ? p.parent : null;
      if (kind === 'response' && name === 'json' && call) return this.flow(call, 'json', []);
      if ((kind === 'axios' || kind === 'swr') && name === 'data') return this.flow(p, 'json', []);
      if (name === 'then' && call) {
        const cb = call.arguments[0];
        if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))) {
          const param = cb.parameters[0];
          let any = false;
          if (param) any = this.bind(param.name, kind, path, cb.body) || any;
          // What the callback returns becomes the next .then's value.
          const ret = ts.isBlock(cb.body) ? null : cb.body;
          if (ret && param && ts.isIdentifier(param.name)) {
            const pn = param.name.text;
            const r = unwrap(ts, ret);
            if (kind === 'response' && ts.isCallExpression(r) && ts.isPropertyAccessExpression(r.expression) && r.expression.name.text === 'json' && isId(ts, r.expression.expression, pn)) {
              any = this.flow(call, 'json', []) || any;
            } else if (kind === 'axios' && ts.isPropertyAccessExpression(r) && r.name.text === 'data' && isId(ts, r.expression, pn)) {
              any = this.flow(call, 'json', []) || any;
            }
          }
          return any;
        }
      }
      return false;
    }
    if (ts.isVariableDeclaration(p) && p.initializer === e) {
      const scope = scopeOf(ts, p);
      return this.bind(p.name, kind, path, scope);
    }
    return false;
  }

  /** A binding receives a value of `kind`: track its uses within `scope`. */
  private bind(name: TsNs.BindingName, kind: Kind, path: string[], scope: TsNs.Node): boolean {
    const ts = this.ts;
    if (ts.isIdentifier(name)) {
      let any = false;
      for (const ref of refsOf(ts, scope, name)) any = this.flow(ref, kind, path) || any;
      return any || kind === 'json';
    }
    if (ts.isObjectBindingPattern(name)) {
      let any = false;
      for (const el of name.elements) {
        if (el.dotDotDotToken) continue;
        const keyNode = el.propertyName ?? el.name;
        const key = ts.isIdentifier(keyNode) || ts.isStringLiteral(keyNode) ? keyNode.text : null;
        if (key === null) continue;
        if (kind === 'json') {
          this.accesses.push({ path: [...path, key], line: this.lineOf(el), text: snippet(el, this.sf) });
          this.bind(el.name, 'json', [...path, key], scope);
          any = true;
        } else if ((kind === 'swr' || kind === 'axios') && key === 'data') {
          any = this.bind(el.name, 'json', [], scope) || any;
        }
      }
      return any;
    }
    if (ts.isArrayBindingPattern(name) && kind === 'json') {
      for (const el of name.elements) if (ts.isBindingElement(el)) this.bind(el.name, 'json', [...path, '[]'], scope);
      return true;
    }
    return false;
  }

  /** A JSON value at `path` is used at `e`: record the property path it reads. */
  private access(e: TsNs.Expression, path: string[]): void {
    const ts = this.ts;
    let cur: TsNs.Expression = e;
    let p = [...path];
    // Record this access before following callbacks, so a line shows its outer expression.
    const later: (() => void)[] = [];
    for (;;) {
      const parent: TsNs.Node = cur.parent;
      if (ts.isPropertyAccessExpression(parent) && parent.expression === cur) {
        const name = parent.name.text;
        const call = ts.isCallExpression(parent.parent) && parent.parent.expression === parent ? parent.parent : null;
        if (call && ARRAY_CALLBACKS.test(name)) {
          const cb = call.arguments[0];
          if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) && cb.parameters[0]) {
            const el = [...p, '[]'];
            const param = cb.parameters[0].name;
            later.push(() => this.bind(param, 'json', el, cb.body));
          }
          if (name === 'find' || name === 'findLast') {
            p = [...p, '[]'];
            cur = call;
            continue;
          }
          break;
        }
        if (name === 'then' && call) {
          // promiseOfJson.then((data) => …)
          const cb = call.arguments[0];
          if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) && cb.parameters[0]) {
            const at = p;
            const param = cb.parameters[0].name;
            later.push(() => this.bind(param, 'json', at, cb.body));
          }
          break;
        }
        if (name === 'length' || call) break;
        p = [...p, name];
        cur = parent;
        continue;
      }
      if (ts.isElementAccessExpression(parent) && parent.expression === cur) {
        const a = parent.argumentExpression;
        if (ts.isStringLiteralLike(a)) p = [...p, a.text];
        else p = [...p, '[]'];
        cur = parent;
        continue;
      }
      if (ts.isNonNullExpression(parent) || ts.isParenthesizedExpression(parent)) {
        cur = parent;
        continue;
      }
      if ((ts.isAwaitExpression(parent) || ts.isAsExpression(parent)) && parent.expression === cur) {
        cur = parent;
        continue;
      }
      // `data = await res.json()` into a variable declared earlier (`let data: T;`).
      if (ts.isBinaryExpression(parent) && parent.right === cur && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(parent.left)) {
        const target = parent.left;
        const at = p;
        later.push(() => this.bind(target, 'json', at, functionOf(ts, parent)));
        break;
      }
      if (ts.isVariableDeclaration(parent) && parent.initializer === cur) {
        const at = p;
        later.push(() => this.bind(parent.name, 'json', at, scopeOf(ts, parent)));
      }
      break;
    }
    if (p.length > path.length) this.accesses.push({ path: p, line: this.lineOf(cur), text: snippet(cur, this.sf) });
    for (const f of later) f();
  }
}

function unwrap(ts: Ts, e: TsNs.Node): TsNs.Node {
  while (ts.isParenthesizedExpression(e) || ts.isAwaitExpression(e)) e = e.expression;
  return e;
}

const isId = (ts: Ts, e: TsNs.Node, name: string) => ts.isIdentifier(e) && e.text === name;

/** Body of the function containing `n` (or the file). */
function functionOf(ts: Ts, n: TsNs.Node): TsNs.Node {
  let cur: TsNs.Node | undefined = n.parent;
  while (cur && !ts.isFunctionLike(cur) && !ts.isSourceFile(cur)) cur = cur.parent;
  if (cur && ts.isFunctionLike(cur) && 'body' in cur && cur.body) return cur.body as TsNs.Node;
  return n.getSourceFile();
}

function scopeOf(ts: Ts, n: TsNs.Node): TsNs.Node {
  let cur: TsNs.Node | undefined = n.parent;
  while (cur && !ts.isBlock(cur) && !ts.isSourceFile(cur) && !ts.isFunctionLike(cur)) cur = cur.parent;
  return cur ?? n.getSourceFile();
}

/** Identifier references to `decl`'s name inside `scope` (excluding the declaration itself). */
function refsOf(ts: Ts, scope: TsNs.Node, decl: TsNs.Identifier): TsNs.Identifier[] {
  const out: TsNs.Identifier[] = [];
  const name = decl.text;
  const visit = (n: TsNs.Node) => {
    if (ts.isIdentifier(n) && n.text === name && n !== decl) {
      const p = n.parent;
      const isName = (ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isPropertyAssignment(p) && p.name === n) || (ts.isBindingElement(p) && p.propertyName === n);
      if (!isName) out.push(n);
    }
    ts.forEachChild(n, visit);
  };
  visit(scope);
  return out;
}
