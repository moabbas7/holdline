import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findConnectionString, parseDotenv } from '../../src/probes/database/live/env.js';
import { redact, safeError } from '../../src/probes/database/live/redact.js';
import { isLocalHost, parseConnectionString } from '../../src/probes/database/live/target.js';
import { WINDOWS } from '../helpers/platform.js';
import { cleanupAll, makeRepo } from '../helpers/tmpRepo.js';

afterEach(cleanupAll);

describe('local hosts', () => {
  it.each([
    'localhost',
    'LOCALHOST',
    'app.localhost',
    '127.0.0.1',
    '127.0.1.1',
    '::1',
    '[::1]',
    '0.0.0.0',
    'host.docker.internal',
    'db',
    'postgres',
    'supabase_db_myapp',
  ])('%s is local', (h) => expect(isLocalHost(h)).toBe(true));

  it.each([
    'db.abcdefghijkl.supabase.co',
    'aws-0-eu-west-1.pooler.supabase.com',
    'prod.example.com',
    '10.0.0.5',
    '192.168.1.20',
    '172.17.0.2',
    '8.8.8.8',
    '2001:db8::1',
    'localhost.evil.com',
  ])('%s is not local', (h) => expect(isLocalHost(h)).toBe(false));
});

describe('connection strings', () => {
  it('parses Postgres URLs into an explicit target', () => {
    const r = parseConnectionString('postgresql://postgres:p%40ss@127.0.0.1:54322/postgres', { root: '/p' });
    expect(r).toMatchObject({ ok: true, target: { dialect: 'postgres', host: '127.0.0.1', port: 54322, user: 'postgres', password: 'p@ss', database: 'postgres', ssl: false } });
    expect(r.secrets).toEqual(expect.arrayContaining(['p%40ss', 'p@ss']));
    const remote = parseConnectionString('postgres://u:pw1@db.x.supabase.co/postgres', { root: '/p' });
    expect(remote).toMatchObject({ ok: true, target: { port: 5432, ssl: { rejectUnauthorized: false } } });
    const verify = parseConnectionString('postgres://u:pw1@localhost/db?sslmode=verify-full', { root: '/p' });
    expect(verify).toMatchObject({ ok: true, target: { ssl: { rejectUnauthorized: true } } });
  });

  it('rejects anything that could connect somewhere other than the parsed host', () => {
    expect(parseConnectionString('postgres://u:p@localhost/db?host=prod.example.com', { root: '/' })).toMatchObject({ ok: false, reason: expect.stringMatching(/"host" parameter/) });
    expect(parseConnectionString('postgres://u:p@localhost/db?hostaddr=1.2.3.4', { root: '/' })).toMatchObject({ ok: false });
    expect(parseConnectionString('postgres://u:p@a:5432,b:5432/db', { root: '/' })).toMatchObject({ ok: false, reason: expect.stringMatching(/several hosts/) });
    expect(parseConnectionString('postgres://u:p@%2Fvar%2Frun%2Fpostgresql/db', { root: '/' })).toMatchObject({ ok: false, reason: expect.stringMatching(/Unix socket/) });
    expect(parseConnectionString('mysql://u:p@localhost/db', { root: '/' })).toMatchObject({ ok: false, reason: expect.stringMatching(/unsupported/) });
  });

  it('resolves Prisma SQLite file: URLs against the schema.prisma folder', () => {
    expect(parseConnectionString('file:./dev.db', { root: '/p', prismaDir: '/p/prisma' })).toMatchObject({ ok: true, target: { dialect: 'sqlite', file: path.resolve('/p/prisma/dev.db') } });
    expect(parseConnectionString('sqlite:data/app.sqlite', { root: '/p' })).toMatchObject({ ok: true, target: { file: path.resolve('/p/data/app.sqlite') } });
    expect(parseConnectionString('file:///srv/data/app.sqlite', { root: '/p' })).toMatchObject({ ok: true, target: { file: path.resolve('/srv/data/app.sqlite') } });
  });

  // file:///C:/… is an absolute Windows path, not /C:/… under the current drive.
  it.runIf(WINDOWS)('reads file:///C:/… as a Windows drive path (Windows only)', () => {
    expect(parseConnectionString('file:///C:/data/app.sqlite', { root: 'D:\\p' })).toMatchObject({ ok: true, target: { file: 'C:\\data\\app.sqlite' } });
  });
});

describe('.env files', () => {
  it('parses quotes, export, comments and ${VAR} references', () => {
    const env = parseDotenv('# c\nexport A=1\nB="two # not a comment"\nC=three # comment\nD=\'x\'\nE=${A}-${B}\nM="line1\nline2"\n');
    expect(Object.fromEntries(env)).toEqual({ A: '1', B: 'two # not a comment', C: 'three', D: 'x', E: '1-two # not a comment', M: 'line1\nline2' });
  });

  it('picks the variable by name order and files by precedence, and never reads .env.production', async () => {
    const t = makeRepo();
    t.write('.env', 'DATABASE_URL=postgres://a@localhost/env\n');
    t.write('.env.local', 'DIRECT_URL=postgres://a@localhost/direct\n');
    t.write('.env.production', 'DATABASE_URL=postgres://a@prod.example.com/prod\n');
    t.write('.env.development.local', 'POSTGRES_URL=postgres://a@localhost/pg\n');
    expect(await findConnectionString(t.dir)).toEqual({ envVar: 'DATABASE_URL', envFile: '.env', value: 'postgres://a@localhost/env' });
    t.write('.env.local', 'DATABASE_URL=postgres://a@localhost/local\n');
    expect(await findConnectionString(t.dir)).toMatchObject({ envFile: '.env.local', value: 'postgres://a@localhost/local' });
    t.write('.env', 'MY_DB=postgres://a@localhost/custom\n');
    expect(await findConnectionString(t.dir, 'MY_DB')).toMatchObject({ envVar: 'MY_DB', value: 'postgres://a@localhost/custom' });
    t.rm('.env').rm('.env.local').rm('.env.development.local');
    expect(await findConnectionString(t.dir)).toBeNull();
  });
});

describe('redaction', () => {
  const url = 'postgres://admin:S3cret-xyz@db.example.com:5432/app';
  const secrets = parseConnectionString(url, { root: '/' }).secrets;

  it('removes the URL, password and user from any message', () => {
    const msg = redact(`failed to connect to ${url} as admin with password S3cret-xyz`, secrets);
    expect(msg).not.toMatch(/S3cret|admin/);
    expect(redact('see postgres://someone:else@host/db', [])).toBe('see postgres://***@host/db');
  });

  it('turns driver errors into fixed, secret-free explanations', () => {
    expect(safeError(Object.assign(new Error('password authentication failed for user "admin"'), { code: '28P01' }), secrets)).toBe('authentication failed');
    expect(safeError(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' }), secrets)).toMatch(/connection refused/);
    expect(safeError(Object.assign(new Error('database "app" does not exist'), { code: '3D000' }), secrets)).toBe('database does not exist');
    expect(safeError(new Error(`weird failure mentioning ${url} and S3cret-xyz`), secrets)).not.toMatch(/S3cret|admin/);
  });
});
