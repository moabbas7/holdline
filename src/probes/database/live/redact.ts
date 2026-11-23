/**
 * Every message that leaves the live-database code goes through here, so a connection
 * string, user name or password can never reach the terminal, --json output or a file.
 */

/** Replace every occurrence of each secret (and its URL-encoded / decoded forms) with ***. */
export function redact(text: string, secrets: string[]): string {
  const forms = new Set<string>();
  for (const s of secrets) {
    if (!s || s.length < 3) continue;
    forms.add(s);
    try {
      forms.add(decodeURIComponent(s));
    } catch {
      /* not encoded */
    }
    forms.add(encodeURIComponent(s));
  }
  let out = text;
  // Longest first, so a URL is replaced before the password inside it.
  for (const f of [...forms].sort((a, b) => b.length - a.length)) out = out.split(f).join('***');
  // Belt and braces: any URL with credentials.
  return out.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi, '$1***@');
}

/** A short, secret-free explanation of a connection or query error. */
export function safeError(e: unknown, secrets: string[]): string {
  const err = e as { code?: string; message?: string } | undefined;
  const code = err?.code ?? '';
  const msg = String(err?.message ?? e ?? '');
  if (code === 'ECONNREFUSED' || /ECONNREFUSED/.test(msg)) return 'connection refused (is the database running?)';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'host not found';
  if (code === 'ETIMEDOUT' || /timeout|timed out/i.test(msg)) return 'timed out';
  if (code === 'ECONNRESET') return 'connection closed by the server';
  if (code === '28P01' || code === '28000' || /password authentication failed|authentication/i.test(msg)) return 'authentication failed';
  if (code === '3D000') return 'database does not exist';
  if (code === '57014') return 'query cancelled (statement timeout)';
  if (/ssl|tls/i.test(msg)) return 'SSL/TLS negotiation failed';
  if (code === 'ERR_UNKNOWN_BUILTIN_MODULE' || /node:sqlite/.test(msg)) return 'node:sqlite is not available in this Node.js version (needs 22.13 or later)';
  if (/unable to open database|SQLITE_CANTOPEN|no such file/i.test(msg)) return 'the SQLite file could not be opened';
  const clean = redact(msg, secrets).replace(/\s+/g, ' ').trim();
  return clean.length > 160 ? `${clean.slice(0, 157)}…` : clean || 'unknown error';
}
