import { readFileSync } from 'node:fs';

/** holdline's package.json (it sits one level above src/ and dist/). */
const pkg: { version?: string; engines?: { node?: string } } = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as typeof pkg;
  } catch {
    return {};
  }
})();

/** holdline's own version. */
export const HOLDLINE_VERSION: string = pkg.version ?? 'unknown';

/** The lowest Node.js version holdline supports, from package.json "engines" (">=22.13" → "22.13.0"). */
export const MIN_NODE: string = (() => {
  const m = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(pkg.engines?.node ?? '');
  return m ? `${m[1]}.${m[2] ?? 0}.${m[3] ?? 0}` : '0.0.0';
})();

/** Is `version` ("22.13.1", "v24.0.0") at least `min`? */
export function nodeAtLeast(version: string, min = MIN_NODE): boolean {
  const parts = (v: string) => v.replace(/^v/, '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  const a = parts(version);
  const b = parts(min);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}
