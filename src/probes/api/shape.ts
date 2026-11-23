/**
 * JSON shapes: merging, printing and diffing (no TypeScript needed), plus shapes of live JSON
 * values (types only, values are never kept).
 */
import type { Field, Shape } from './types.js';

export const UNKNOWN = (why?: string): Shape => ({ k: 'unknown', ...(why ? { why } : {}) });
export const isUnknown = (s: Shape) => s.k === 'unknown';

const ORDER = ['null', 'boolean', 'number', 'string', 'array', 'object', 'unknown'];

/** Merge two shapes into one that describes both (a union, objects and arrays merged). */
export function mergeShapes(a: Shape, b: Shape): Shape {
  return union([a, b]);
}

/** Normalised union: flattened, deduplicated, one object member and one array member at most. */
export function union(shapes: Shape[]): Shape {
  const flat: Shape[] = [];
  for (const s of shapes) {
    if (s.k === 'union') flat.push(...s.of);
    else flat.push(s);
  }
  const unknown = flat.find((s) => s.k === 'unknown');
  if (unknown) return unknown;
  const prims = new Set<string>();
  const objects: Extract<Shape, { k: 'object' }>[] = [];
  const arrays: Extract<Shape, { k: 'array' }>[] = [];
  for (const s of flat) {
    if (s.k === 'object') objects.push(s);
    else if (s.k === 'array') arrays.push(s);
    else prims.add(s.k);
  }
  const out: Shape[] = [...prims].map((k) => ({ k }) as Shape);
  if (arrays.length) out.push({ k: 'array', of: arrays.length === 1 ? arrays[0]!.of : union(arrays.map((x) => x.of)) });
  if (objects.length) out.push(objects.length === 1 ? objects[0]! : mergeObjects(objects));
  out.sort((x, y) => ORDER.indexOf(x.k) - ORDER.indexOf(y.k));
  if (out.length === 0) return UNKNOWN('empty');
  return out.length === 1 ? out[0]! : { k: 'union', of: out };
}

function mergeObjects(objs: Extract<Shape, { k: 'object' }>[]): Shape {
  const keys = new Set(objs.flatMap((o) => Object.keys(o.fields)));
  const fields: Record<string, Field> = {};
  for (const k of [...keys].sort()) {
    const present = objs.map((o) => o.fields[k]).filter((f): f is Field => !!f);
    const shape = union(present.map((f) => f.shape));
    let optional: Field['optional'] = present.length < objs.length;
    if (!optional) {
      if (present.some((f) => f.optional === true)) optional = true;
      else if (present.some((f) => f.optional === 'unknown')) optional = 'unknown';
    }
    fields[k] = { shape, optional };
  }
  const out: Extract<Shape, { k: 'object' }> = { k: 'object', fields };
  if (objs.some((o) => o.open)) out.open = true;
  const values = objs.map((o) => o.values).filter((v): v is Shape => !!v);
  if (values.length) out.values = union(values);
  return out;
}

const IDENT = /^[A-Za-z_$][\w$]*$/;

/** Compact TypeScript-like text: `{ id: number, tags: string[], email?: string | null }`. */
export function shapeText(s: Shape | null, maxLen = 2000): string {
  if (s === null) return '(no JSON body)';
  const t = text(s);
  return t.length > maxLen ? t.slice(0, maxLen - 1) + '…' : t;
}

function text(s: Shape): string {
  switch (s.k) {
    case 'unknown':
      return 'unknown';
    case 'array': {
      const inner = text(s.of);
      return s.of.k === 'union' ? `(${inner})[]` : `${inner}[]`;
    }
    case 'union':
      return s.of.map(text).join(' | ');
    case 'object': {
      const parts = Object.entries(s.fields).map(([k, f]) => `${IDENT.test(k) ? k : JSON.stringify(k)}${f.optional === true ? '?' : ''}: ${text(f.shape)}`);
      if (s.values) parts.push(`[key: string]: ${text(s.values)}`);
      if (s.open) parts.push('…');
      return parts.length ? `{ ${parts.join(', ')} }` : '{}';
    }
    default:
      return s.k;
  }
}

/** Shape of a parsed JSON value. Values are discarded; only types are kept. */
export function shapeOfValue(v: unknown, depth = 0): Shape {
  if (depth > 12) return UNKNOWN('too deep');
  if (v === null) return { k: 'null' };
  if (Array.isArray(v)) {
    if (v.length === 0) return { k: 'array', of: UNKNOWN('empty array') };
    return { k: 'array', of: union(v.slice(0, 50).map((x) => shapeOfValue(x, depth + 1))) };
  }
  switch (typeof v) {
    case 'string':
      return { k: 'string' };
    case 'number':
      return { k: 'number' };
    case 'boolean':
      return { k: 'boolean' };
    case 'object': {
      const fields: Record<string, Field> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 300)) fields[k] = { shape: shapeOfValue(x, depth + 1), optional: false };
      return { k: 'object', fields };
    }
    default:
      return UNKNOWN();
  }
}

// --- Diff -------------------------------------------------------------------------------

export type ShapeChangeKind = 'field-removed' | 'field-added' | 'type-changed' | 'became-optional' | 'became-required' | 'unknown';

export interface ShapeChange {
  kind: ShapeChangeKind;
  /** Field path, e.g. ['user', 'email'] or ['items', '[]', 'id']; [] is the body itself. */
  path: string[];
  from?: string;
  to?: string;
}

export const pathText = (p: string[]) => (p.length === 0 ? '(body)' : p.join('.').replace(/\.\[\]/g, '[]'));

/** Top-level kinds of a shape (for type comparison). */
function kinds(s: Shape): string[] {
  return (s.k === 'union' ? s.of.map((x) => x.k) : [s.k]).sort();
}
const member = (s: Shape, k: 'object' | 'array') => (s.k === k ? s : s.k === 'union' ? s.of.find((x) => x.k === k) : undefined);

/**
 * Differences between two shapes. Anything involving an unknown shape yields one 'unknown'
 * item and never a removal or type change. `loose`: live data, where a null seen in one
 * run and a value in another is not a type change.
 */
export function diffShapes(before: Shape, after: Shape, opts: { loose?: boolean } = {}, path: string[] = [], out: ShapeChange[] = []): ShapeChange[] {
  if (before.k === 'unknown' || after.k === 'unknown') {
    // Known → unknown is worth a note; unknown → known only means better type information.
    if (before.k !== 'unknown') out.push({ kind: 'unknown', path, from: text(before), to: text(after) });
    return out;
  }
  let kb = kinds(before);
  let ka = kinds(after);
  if (opts.loose) {
    kb = kb.filter((k) => k !== 'null');
    ka = ka.filter((k) => k !== 'null');
    if (kb.length === 0 || ka.length === 0) return out;
  }
  if (kb.join() !== ka.join()) {
    out.push({ kind: 'type-changed', path, from: text(before), to: text(after) });
    return out;
  }
  const ob = member(before, 'object') as Extract<Shape, { k: 'object' }> | undefined;
  const oa = member(after, 'object') as Extract<Shape, { k: 'object' }> | undefined;
  if (ob && oa) {
    for (const [k, fb] of Object.entries(ob.fields)) {
      const fa = oa.fields[k];
      const p = [...path, k];
      if (!fa) {
        if (oa.open || oa.values) out.push({ kind: 'unknown', path: p, from: text(fb.shape), to: 'unknown' });
        else out.push({ kind: 'field-removed', path: p, from: text(fb.shape) });
        continue;
      }
      if (fb.optional === false && fa.optional === true) out.push({ kind: 'became-optional', path: p });
      else if (fb.optional === true && fa.optional === false) out.push({ kind: 'became-required', path: p });
      diffShapes(fb.shape, fa.shape, opts, p, out);
    }
    for (const [k, fa] of Object.entries(oa.fields)) {
      if (!ob.fields[k] && !ob.open) out.push({ kind: 'field-added', path: [...path, k], to: text(fa.shape) + (fa.optional === true ? ' (optional)' : '') });
    }
    if (ob.values && oa.values) diffShapes(ob.values, oa.values, opts, [...path, '[key]'], out);
  }
  const ab = member(before, 'array') as Extract<Shape, { k: 'array' }> | undefined;
  const aa = member(after, 'array') as Extract<Shape, { k: 'array' }> | undefined;
  if (ab && aa) diffShapes(ab.of, aa.of, opts, [...path, '[]'], out);
  return out;
}
