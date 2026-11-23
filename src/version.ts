import { readFileSync } from 'node:fs';

/** holdline's own version (package.json sits one level above src/ and dist/). */
export const HOLDLINE_VERSION: string = (() => {
  try {
    return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
})();
