/**
 * Reads the database connection string from the project's .env files. Values are returned
 * to the caller only; nothing is put in process.env, logged or stored.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** Highest precedence first (Next.js order for development). Production files are never read. */
export const ENV_FILES = ['.env.development.local', '.env.local', '.env.development', '.env'];
export const DEFAULT_ENV_VARS = ['DATABASE_URL', 'POSTGRES_URL', 'DIRECT_URL'];

/** Minimal dotenv parser: KEY=value, `export KEY=value`, quotes, inline comments, ${VAR} expansion. */
export function parseDotenv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*=\s*(.*)$/.exec(lines[i]!);
    if (!m) continue;
    let v = m[2]!;
    const q = v[0];
    if (q === '"' || q === "'" || q === '`') {
      // Quoted values may span lines.
      let body = v.slice(1);
      while (!body.includes(q) && i + 1 < lines.length) body += '\n' + lines[++i];
      const end = body.indexOf(q);
      v = end >= 0 ? body.slice(0, end) : body;
      if (q === '"') v = v.replace(/\\n/g, '\n');
    } else {
      v = v.replace(/\s+#.*$/, '').trim();
    }
    out.set(m[1]!, v);
  }
  for (const [k, v] of out) {
    if (v.includes('${')) out.set(k, v.replace(/\$\{([A-Za-z_]\w*)\}/g, (_, name: string) => out.get(name) ?? ''));
  }
  return out;
}

export interface FoundUrl {
  envVar: string;
  envFile: string;
  value: string;
}

/** First connection string found, checking variables in order and files by precedence. */
export async function findConnectionString(root: string, extraVar?: string): Promise<FoundUrl | null> {
  const vars = extraVar ? [extraVar, ...DEFAULT_ENV_VARS.filter((v) => v !== extraVar)] : DEFAULT_ENV_VARS;
  const parsed: { file: string; env: Map<string, string> }[] = [];
  for (const file of ENV_FILES) {
    try {
      parsed.push({ file, env: parseDotenv(await readFile(path.join(root, file), 'utf8')) });
    } catch {
      /* missing */
    }
  }
  for (const v of vars) {
    for (const { file, env } of parsed) {
      const value = env.get(v);
      if (value) return { envVar: v, envFile: file, value };
    }
  }
  return null;
}
