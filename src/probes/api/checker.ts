/**
 * TypeScript types and expressions → JSON shapes, using the type checker. Object and array
 * literals are read directly; everything else comes from the checker. What can't be
 * determined (any, unknown, unresolved imports) becomes `unknown`, never a guess.
 */
import type { ts as TsNs } from 'ts-morph';
import { union, UNKNOWN } from './shape.js';
import type { Field, Shape } from './types.js';

type Ts = typeof TsNs;

const MAX_DEPTH = 8;
const MAX_FIELDS = 200;

/** Marker for `undefined`/`void`: such members make a field optional and are dropped from JSON. */
const UNDEF = { k: 'unknown', why: '\0undefined' } as const satisfies Shape;
/** Marker for functions and symbols: dropped from JSON objects. */
const DROP = { k: 'unknown', why: '\0drop' } as const satisfies Shape;
const isMarker = (s: Shape) => s === UNDEF || s === DROP;

export class ShapeReader {
  constructor(
    private readonly ts: Ts,
    private readonly checker: TsNs.TypeChecker,
  ) {}

  /** Shape of a type as JSON.stringify would emit it. `optional` reports `| undefined`. */
  typeShape(type: TsNs.Type, at: TsNs.Node): Shape {
    const s = this.type(type, at, 0, new Set());
    return s === UNDEF || s === DROP ? UNKNOWN('undefined') : s;
  }

  /** Is `type` any/unknown/error (nothing to learn from it)? */
  isOpaque(type: TsNs.Type): boolean {
    const F = this.ts.TypeFlags;
    return (type.flags & (F.Any | F.Unknown | F.Never)) !== 0;
  }

  private type(t: TsNs.Type, at: TsNs.Node, depth: number, seen: Set<TsNs.Type>): Shape {
    const ts = this.ts;
    const F = ts.TypeFlags;
    const c = this.checker;
    if (depth > MAX_DEPTH) return UNKNOWN('nested too deeply');
    const f = t.flags;
    if (f & F.Any) return UNKNOWN('any');
    if (f & (F.Unknown | F.Never)) return UNKNOWN('unknown type');
    if (f & (F.Undefined | F.Void)) return UNDEF;
    if (f & F.Null) return { k: 'null' };
    if (f & (F.String | F.StringLiteral | F.TemplateLiteral | F.StringMapping)) return { k: 'string' };
    if (f & (F.Number | F.NumberLiteral)) return { k: 'number' };
    if (f & (F.Boolean | F.BooleanLiteral)) return { k: 'boolean' };
    if (f & (F.BigInt | F.BigIntLiteral)) return UNKNOWN('bigint (not JSON-serialisable)');
    if (f & (F.ESSymbol | F.UniqueESSymbol)) return DROP;
    if (f & F.EnumLiteral && t.isUnion()) return this.type(c.getBaseTypeOfLiteralType(t), at, depth, seen);
    if (f & F.TypeParameter) {
      const con = c.getBaseConstraintOfType(t);
      return con && con !== t ? this.type(con, at, depth, seen) : UNKNOWN('generic type');
    }
    if (t.isUnion()) {
      const parts = t.types.map((x) => this.type(x, at, depth, seen));
      const real = parts.filter((p) => !isMarker(p));
      if (real.length === 0) return parts.includes(UNDEF) ? UNDEF : DROP;
      const u = union(real);
      return parts.includes(UNDEF) ? { k: 'union', of: [u, UNDEF] } : u;
    }
    if (!(f & F.Object) && !t.isIntersection()) return UNKNOWN(`type ${c.typeToString(t)}`);
    if (seen.has(t)) return UNKNOWN('recursive type');
    seen.add(t);
    try {
      // toJSON (Date → string, and any class that defines it).
      const toJSON = t.getProperty('toJSON');
      if (toJSON) {
        const sig = c.getSignaturesOfType(c.getTypeOfSymbolAtLocation(toJSON, at), ts.SignatureKind.Call)[0];
        if (sig) return this.type(c.getReturnTypeOfSignature(sig), at, depth + 1, seen);
      }
      if (c.isArrayType(t) || c.isTupleType(t)) {
        const args = c.getTypeArguments(t as TsNs.TypeReference);
        if (args.length === 0) return { k: 'array', of: UNKNOWN('empty tuple') };
        const els = args.map((a) => this.type(a, at, depth + 1, seen)).map((s) => (isMarker(s) ? { k: 'null' } as Shape : s));
        return { k: 'array', of: union(els.map(stripUndef)) };
      }
      if (c.getSignaturesOfType(t, ts.SignatureKind.Call).length > 0 && t.getProperties().length === 0) return DROP;
      const name = t.getSymbol()?.getName();
      if (name === 'Promise') return UNKNOWN('a Promise (not awaited)');
      if (name === 'Map' || name === 'Set' || name === 'WeakMap' || name === 'RegExp') return { k: 'object', fields: {} };
      const fields: Record<string, Field> = {};
      const props = c.getPropertiesOfType(t);
      let open = false;
      for (const p of props.slice(0, MAX_FIELDS)) {
        if (p.flags & (ts.SymbolFlags.Method | ts.SymbolFlags.Prototype)) continue;
        const decl = p.valueDeclaration ?? p.declarations?.[0];
        if (decl && ts.getCombinedModifierFlags(decl as TsNs.Declaration) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) continue;
        if (p.getName().startsWith('__@')) continue; // symbol-keyed
        const pt = c.getTypeOfSymbolAtLocation(p, at);
        const s = this.type(pt, at, depth + 1, seen);
        if (s === DROP || s === UNDEF) continue;
        const hasUndef = s.k === 'union' && s.of.includes(UNDEF);
        fields[p.getName()] = { shape: stripUndef(s), optional: (p.flags & ts.SymbolFlags.Optional) !== 0 || hasUndef };
      }
      if (props.length > MAX_FIELDS) open = true;
      const obj: Extract<Shape, { k: 'object' }> = { k: 'object', fields };
      const idx = c.getIndexInfosOfType(t).find((i) => i.keyType.flags & (F.String | F.Number));
      if (idx) {
        const v = this.type(idx.type, at, depth + 1, seen);
        obj.values = isMarker(v) ? UNKNOWN() : stripUndef(v);
      }
      if (open) obj.open = true;
      return obj;
    } finally {
      seen.delete(t);
    }
  }

  /**
   * Shape of an expression that is serialised as JSON. Literals are read syntactically (so a
   * plain object works even when nothing else type-checks), the rest through the checker.
   * Returns UNDEF-free shapes; `undefinedPossible` tells callers a field may be omitted.
   */
  exprShape(e: TsNs.Expression, depth = 0): Shape {
    const s = this.expr(e, depth);
    return isMarker(s) ? UNKNOWN('undefined') : stripUndef(s);
  }

  /** Like exprShape, but reports whether the value can be undefined (field omitted). */
  fieldShape(e: TsNs.Expression, depth: number): { shape: Shape; optional: boolean } | null {
    const s = this.expr(e, depth);
    if (s === DROP) return null;
    if (s === UNDEF) return null;
    return { shape: stripUndef(s), optional: s.k === 'union' && s.of.includes(UNDEF) };
  }

  private expr(e: TsNs.Expression, depth: number): Shape {
    const ts = this.ts;
    if (depth > MAX_DEPTH) return UNKNOWN('nested too deeply');
    if (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression(e)) return this.expr(e.expression, depth);
    if (ts.isAsExpression(e) || ts.isTypeAssertionExpression(e)) {
      if (ts.isConstTypeReference(e.type)) return this.expr(e.expression, depth);
      const t = this.checker.getTypeAtLocation(e);
      if (!this.isOpaque(t)) return this.type(t, e, depth, new Set());
      return this.expr(e.expression, depth);
    }
    if (ts.isStringLiteralLike(e) || ts.isTemplateExpression(e)) return { k: 'string' };
    if (ts.isNumericLiteral(e)) return { k: 'number' };
    if (e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword) return { k: 'boolean' };
    if (e.kind === ts.SyntaxKind.NullKeyword) return { k: 'null' };
    if (ts.isIdentifier(e) && e.text === 'undefined') return UNDEF;
    if (ts.isPrefixUnaryExpression(e)) return e.operator === ts.SyntaxKind.ExclamationToken ? { k: 'boolean' } : { k: 'number' };
    if (ts.isConditionalExpression(e)) {
      const a = this.expr(e.whenTrue, depth);
      const b = this.expr(e.whenFalse, depth);
      return joinWithUndef([a, b]);
    }
    if (ts.isArrayLiteralExpression(e)) {
      const parts: Shape[] = [];
      for (const el of e.elements) {
        if (ts.isSpreadElement(el)) {
          const t = this.type(this.checker.getTypeAtLocation(el.expression), el, depth + 1, new Set());
          parts.push(t.k === 'array' ? t.of : UNKNOWN('spread'));
        } else {
          const s = this.expr(el, depth + 1);
          parts.push(isMarker(s) ? { k: 'null' } : stripUndef(s));
        }
      }
      return { k: 'array', of: parts.length ? union(parts) : UNKNOWN('empty array') };
    }
    if (ts.isObjectLiteralExpression(e)) {
      const fields: Record<string, Field> = {};
      let open = false;
      for (const p of e.properties) {
        if (ts.isSpreadAssignment(p)) {
          const t = this.type(this.checker.getTypeAtLocation(p.expression), p, depth + 1, new Set());
          const obj = t.k === 'object' ? t : t.k === 'union' ? t.of.find((x) => x.k === 'object') : undefined;
          if (obj && obj.k === 'object') {
            Object.assign(fields, obj.fields);
            if (obj.open) open = true;
            if (t.k === 'union') for (const k of Object.keys(obj.fields)) fields[k] = { ...fields[k]!, optional: true };
          } else if (!(t === UNDEF || (t.k === 'null'))) open = true;
          continue;
        }
        if (ts.isMethodDeclaration(p) || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)) {
          if (ts.isGetAccessorDeclaration(p)) open = true;
          continue;
        }
        const name = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) || ts.isNumericLiteral(p.name) ? p.name.text : null);
        if (name === null || name === undefined) {
          open = true;
          continue;
        }
        if (ts.isShorthandPropertyAssignment(p)) {
          const t = this.checker.getTypeAtLocation(p.name);
          const s = this.type(t, p, depth + 1, new Set());
          const fs = this.asField(s);
          if (fs) fields[name] = fs;
          continue;
        }
        if (ts.isPropertyAssignment(p)) {
          const fs = this.asField(this.expr(p.initializer, depth + 1));
          if (fs) fields[name] = fs;
        }
      }
      const obj: Extract<Shape, { k: 'object' }> = { k: 'object', fields };
      if (open) obj.open = true;
      return obj;
    }
    if (ts.isIdentifier(e)) {
      // A local const initialised with a literal: read the literal (keeps it syntax-first).
      const init = this.localConstInit(e);
      if (init) return this.expr(init, depth + 1);
    }
    const t = this.checker.getTypeAtLocation(e);
    return this.type(t, e, depth, new Set());
  }

  private asField(s: Shape): Field | null {
    if (s === DROP || s === UNDEF) return null;
    return { shape: stripUndef(s), optional: s.k === 'union' && s.of.includes(UNDEF) };
  }

  /** `const x = { … }` / `[ … ]` in the same file, never reassigned (const). */
  localConstInit(id: TsNs.Identifier): TsNs.Expression | null {
    const ts = this.ts;
    const sym = this.checker.getSymbolAtLocation(id);
    const decl = sym?.valueDeclaration;
    if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer || decl.type) return null;
    if (!(ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const)) return null;
    const init = decl.initializer;
    return ts.isObjectLiteralExpression(init) || ts.isArrayLiteralExpression(init) ? init : null;
  }
}

function stripUndef(s: Shape): Shape {
  if (s.k !== 'union' || !s.of.includes(UNDEF)) return s;
  const rest = s.of.filter((x) => x !== UNDEF);
  return rest.length === 1 ? rest[0]! : rest.length ? union(rest) : UNKNOWN('undefined');
}

function joinWithUndef(parts: Shape[]): Shape {
  const undef = parts.some((p) => p === UNDEF || (p.k === 'union' && p.of.includes(UNDEF)));
  const real = parts.map(stripUndef).filter((p) => !isMarker(p));
  if (real.length === 0) return UNDEF;
  const u = union(real);
  return undef ? { k: 'union', of: [u, UNDEF] } : u;
}
