import { afterEach, describe, expect, it } from 'vitest';
import { fieldRefs } from '../../src/probes/api/fieldRefs.js';
import { cleanupAll, makeRepo } from '../helpers/tmpRepo.js';

afterEach(cleanupAll);

describe('lines that read a response field', () => {
  it('follows fetch, .then, SWR, axios, destructuring, aliases and array callbacks', async () => {
    const t = makeRepo();
    t.write(
      'a.tsx',
      [
        "import useSWR from 'swr';",
        "import axios from 'axios';",
        'export async function one() {',
        "  const res = await fetch('/api/x');",
        '  const body = await res.json();',
        '  const user = body.user;',
        '  return user.email;',
        '}',
        'export function Two() {',
        "  const { data: list } = useSWR('/api/list');",
        '  return list?.items.map((it) => it.email);',
        '}',
        'export async function three() {',
        "  const { data } = await axios.get('/api/x');",
        '  const { user: { email } } = data;',
        '  return email;',
        '}',
        'export async function four() {',
        "  return fetch('/api/x').then((r) => r.json()).then((d) => d['user'].email);",
        '}',
        'export async function five() {',
        "  const res = await fetch('/api/x');",
        '  const email = 1; // unrelated variable with the same name',
        '  return res.status + email;',
        '}',
      ].join('\n'),
    );
    const calls = [4, 10, 14, 19, 22].map((line) => ({ file: 'a.tsx', line }));
    const user = await fieldRefs(t.dir, calls, ['user', 'email']);
    expect(user.map((r) => [r.line, r.exact])).toEqual([
      [7, true],
      [15, true],
      [19, true],
    ]);
    const items = await fieldRefs(t.dir, [{ file: 'a.tsx', line: 10 }], ['items', '[]', 'email']);
    expect(items.map((r) => [r.line, r.text])).toEqual([[11, 'it.email']]);
  });

  it('falls back to "possibly" lines when the JSON cannot be traced', async () => {
    const t = makeRepo();
    t.write('b.ts', "import { api } from './client';\nexport async function f() {\n  const u = await api('/api/x');\n  return u.email;\n}\n");
    const refs = await fieldRefs(t.dir, [{ file: 'b.ts', line: 3 }], ['email']);
    expect(refs).toEqual([{ file: 'b.ts', line: 4, text: 'u.email', exact: false }]);
  });
});

describe('assignment to an existing variable', () => {
  it('follows `data = await res.json()`', async () => {
    const t = makeRepo();
    t.write(
      'c.ts',
      [
        'export function check(v: string) {',
        '  fetch(`/api/domains/${v}/validate`).then(async (res) => {',
        '    let data: { status?: unknown };',
        '    try {',
        '      data = await res.json();',
        '    } catch {',
        '      return;',
        '    }',
        '    const status = data.status;',
        '    return status;',
        '  });',
        '}',
      ].join('\n'),
    );
    const refs = await fieldRefs(t.dir, [{ file: 'c.ts', line: 2 }], ['status']);
    expect(refs.map((r) => [r.line, r.exact])).toEqual([[9, true]]);
  });
});
