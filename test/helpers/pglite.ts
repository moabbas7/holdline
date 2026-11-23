import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

/**
 * An embedded Postgres (PGlite, Postgres compiled to WASM) behind a real wire-protocol
 * socket on 127.0.0.1, so holdline's `pg` code path runs exactly as against a server.
 */
export interface TestPg {
  db: PGlite;
  port: number;
  url(opts?: { user?: string; password?: string; host?: string; query?: string }): string;
  /** Drop and recreate the public schema (auth stubs persist). */
  reset(): Promise<void>;
  /** Apply every migration of a fixture folder (create extension lines removed: PGlite has no pgcrypto). */
  migrate(dir: string): Promise<void>;
  stop(): Promise<void>;
}

export async function startPg(): Promise<TestPg> {
  const db = await PGlite.create();
  // Enough of Supabase's environment for its migrations: auth.uid() and the standard roles.
  await db.exec(`
    create schema auth;
    create function auth.uid() returns uuid language sql stable as 'select null::uuid';
    create role authenticated;
    create role anon;
  `);
  const server = new PGLiteSocketServer({ db, port: 0, host: '127.0.0.1', maxConnections: 4 });
  await server.start();
  const port = Number(server.getServerConn().split(':').pop());
  return {
    db,
    port,
    url: ({ user = 'postgres', password = 'postgres', host = '127.0.0.1', query = '' } = {}) =>
      `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/postgres${query}`,
    reset: async () => {
      await db.exec('drop schema public cascade; create schema public;');
    },
    migrate: async (dir) => {
      for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
        await db.exec(readFileSync(path.join(dir, f), 'utf8').replace(/^create extension[^\n]*$/gim, ''));
      }
    },
    stop: async () => {
      await server.stop();
      await db.close();
    },
  };
}
