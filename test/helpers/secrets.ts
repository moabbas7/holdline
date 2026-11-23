import { randomUUID } from 'node:crypto';

/**
 * A made-up secret for leak tests: `<label>_<32 hex chars>`, new on every run. Tests assert
 * it never shows up in output, so it must be something that can't appear there by chance:
 * not a common word that a path (C:\Users\runneradmin\…) or a message could contain.
 * Letters, digits and `_` only, so it works unescaped as a URL user or password and as a
 * Postgres role name.
 */
export function sentinel(label: string): string {
  return `${label}_${randomUUID().replace(/-/g, '')}`;
}
