import { afterEach, describe, expect, it } from 'vitest';
import { apiCommand } from '../../src/commands/api.js';
import { captureApi } from '../../src/probes/api/index.js';
import { diffShapes, shapeOfValue, shapeText, union } from '../../src/probes/api/shape.js';
import type { RouteApi, Shape } from '../../src/probes/api/types.js';
import { fixtureRepo } from '../helpers/fixtures.js';
import { cleanupAll, fakeIo } from '../helpers/tmpRepo.js';

afterEach(cleanupAll);

const resp = (r: RouteApi | undefined, method: string, status: number | 'unknown') => {
  const m = r?.methods[method];
  const x = m?.responses.find((s) => s.status === status);
  return x === undefined ? undefined : shapeText(x.body);
};

describe('shapes', () => {
  it('merges unions: one object, optional fields where members differ', () => {
    const a: Shape = { k: 'object', fields: { id: { shape: { k: 'number' }, optional: false }, name: { shape: { k: 'string' }, optional: false } } };
    const b: Shape = { k: 'object', fields: { id: { shape: { k: 'number' }, optional: false }, error: { shape: { k: 'string' }, optional: false } } };
    expect(shapeText(union([a, b]))).toBe('{ error?: string, id: number, name?: string }');
    expect(shapeText(union([{ k: 'string' }, { k: 'null' }, { k: 'string' }]))).toBe('null | string');
  });

  it('keeps types, never values, for live JSON', () => {
    const s = shapeOfValue({ token: 'SECRET', n: 1, list: [{ a: true }, { a: false, b: null }], empty: [] });
    expect(shapeText(s)).toBe('{ token: string, n: number, list: { a: boolean, b?: null }[], empty: unknown[] }');
    expect(JSON.stringify(s)).not.toContain('SECRET');
  });

  it('diffs: removed fields and type changes; unknown never counts as removed', () => {
    const before = shapeOfValue({ user: { id: 1, email: 'x' }, total: 1 });
    const after = shapeOfValue({ user: { id: 1 }, total: '1' });
    const kinds = diffShapes(before, after).map((c) => `${c.kind}:${c.path.join('.')}`);
    expect(kinds).toEqual(['field-removed:user.email', 'type-changed:total']);
    expect(diffShapes(before, { k: 'unknown' }).map((c) => c.kind)).toEqual(['unknown']);
    // Unknown → known is better type information, not an API change.
    expect(diffShapes({ k: 'unknown' }, before)).toEqual([]);
    const open: Shape = { k: 'object', fields: {}, open: true };
    expect(diffShapes(before, open).every((c) => c.kind === 'unknown')).toBe(true);
  });
});

describe('static analysis: Next.js', () => {
  it('reads typed responses, literals, conditional statuses, nesting, wrappers and requests', async () => {
    const t = fixtureRepo('api-next');
    const { capture } = await captureApi(t.dir, null);
    const r = capture.routes;
    expect(Object.keys(r).sort()).toEqual(['/api/external', '/api/legacy', '/api/projects', '/api/stats', '/api/todos', '/api/users', '/api/users/:id']);

    // Typed: User[] through the checker (Date → string, functions dropped, optional kept).
    expect(resp(r['/api/users'], 'GET', 200)).toBe(
      '{ users: { id: number, name: string, email?: string, createdAt: string, role: string }[], total: number, page: null | string }',
    );
    expect(r['/api/users']!.methods.GET!.request.query).toEqual(['page']);
    // zod-like schema: the input type, optional fields kept optional.
    expect(resp(r['/api/users'], 'POST', 201)).toBe('{ id: number, name: string }');
    expect(shapeText(r['/api/users']!.methods.POST!.request.body!)).toBe('{ name: string, email?: string, role?: string }');

    // Conditional: 404 vs 200, nested objects and arrays, nullable field.
    const byId = r['/api/users/:id']!;
    expect(resp(byId, 'GET', 200)).toBe('{ user: { id: number, name: string, address: { city: string, zip: null | string } }, tags: string[] }');
    expect(resp(byId, 'GET', 404)).toBe('{ error: string }');
    expect(byId.methods.GET!.request.params).toEqual(['id']);
    expect(resp(byId, 'DELETE', 204)).toBe('(no JSON body)');

    // Untyped JavaScript: from the object literal.
    expect(resp(r['/api/stats'], 'GET', 200)).toBe('{ count: number, items: { id: number, label: string }[], ok: boolean }');
    // Wrapper (withAuth(async (ctx) => …)).
    expect(resp(r['/api/projects'], 'GET', 200)).toBe('{ projects: { id: string, name: string, ownerId: string }[], count: number }');

    // Pages router: methods from req.method branches; the trailing 405 belongs to neither.
    const todos = r['/api/todos']!;
    expect(Object.keys(todos.methods).sort()).toEqual(['GET', 'POST']);
    expect(resp(todos, 'GET', 200)).toBe('{ id: number, title: string, done: boolean }[]');
    expect(resp(todos, 'POST', 201)).toBe('{ id: number, title: string, done: boolean }');
    expect(resp(todos, 'GET', 405)).toBeUndefined();
    expect(Object.keys(todos.methods.POST!.request.body!.k === 'object' ? (todos.methods.POST!.request.body as { fields: object }).fields : {})).toEqual(['title']);

    // Can't analyse: unknown, not a guess.
    expect(resp(r['/api/external'], 'GET', 200)).toBe('unknown');
    expect(r['/api/legacy']!.methods.GET!.unknown).toMatch(/makeHandler/);
  });

  it('holdline api works without init and prints shapes; --json returns the routes', async () => {
    const t = fixtureRepo('api-next');
    const io = fakeIo();
    const res = await apiCommand(t.dir, {}, io);
    const out = io.logs.join('\n');
    expect(out).toContain('/api/users/:id');
    expect(out).toContain('404  { error: string }');
    expect(out).toContain('unknown');
    expect(res.routes.length).toBe(7);
    const one = await apiCommand(t.dir, { json: true, route: '/api/users/42' }, fakeIo());
    expect(one.routes.map((x) => x.pattern)).toEqual(['/api/users/:id']);
    expect(t.exists('.holdline')).toBe(false);
  });
});

describe('static analysis: Express', () => {
  it('follows mounts, res.status().json(), sendStatus and named handlers', async () => {
    const t = fixtureRepo('api-express');
    const { capture } = await captureApi(t.dir, null);
    const r = capture.routes;
    expect(Object.keys(r).sort()).toEqual(['/api/health', '/api/orders', '/api/orders/:id']);
    // process has no types in the fixture: unknown, not a guess.
    expect(resp(r['/api/health'], 'GET', 200)).toBe('{ ok: boolean, uptime: unknown }');
    expect(resp(r['/api/orders'], 'GET', 200)).toBe('{ orders: { id: number, total: number, items: { sku: string, qty: number }[], note?: string }[], status: string }');
    expect(r['/api/orders']!.methods.GET!.request.query).toEqual(['status']);
    expect(resp(r['/api/orders'], 'POST', 201)).toBe('{ id: number, sku: string, qty: number }');
    expect(resp(r['/api/orders'], 'POST', 400)).toBe('{ error: string }');
    expect(resp(r['/api/orders/:id'], 'GET', 404)).toBe('(no JSON body)');
    expect(resp(r['/api/orders/:id'], 'GET', 200)).toBe('{ id: number, total: number, items: { sku: string, qty: number }[], note?: string }');
  });
});
