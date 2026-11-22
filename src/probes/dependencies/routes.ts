import path from 'node:path';

const P = path.posix;

export type NextFileRole = { kind: 'api'; pattern: string } | { kind: 'page' } | null;

/** Turn Next.js route segments into a pattern: (group) dropped, [id] → :id, [...x] → *. */
function segmentsToPattern(segs: string[]): string | null {
  const out: string[] = [];
  for (const s of segs) {
    if (s === '' || s === 'index') continue;
    if (s.startsWith('_')) return null; // private folder: not routable
    if (/^\(.*\)$/.test(s) || s.startsWith('@')) continue; // route group / parallel slot
    if (/^\[\[\.\.\..+\]\]$/.test(s)) out.push('*?');
    else if (/^\[\.\.\..+\]$/.test(s)) out.push('*');
    else if (/^\[.+\]$/.test(s)) out.push(':' + s.slice(1, -1));
    else out.push(s);
  }
  return '/' + out.join('/');
}

/**
 * Role of a file inside a Next.js package (path relative to the package folder):
 * an API route with its URL pattern, a page, or neither.
 */
export function nextFileRole(relInPkg: string): NextFileRole {
  const ext = P.extname(relInPkg);
  const noExt = relInPkg.slice(0, -ext.length);
  const app = /^(?:src\/)?app\/(.*)$/.exec(noExt);
  if (app) {
    const segs = app[1]!.split('/');
    const base = segs.pop()!;
    if (base === 'route') {
      const pattern = segmentsToPattern(segs);
      return pattern ? { kind: 'api', pattern } : null;
    }
    if (base === 'page' || base === 'layout') return segmentsToPattern(segs) ? { kind: 'page' } : null;
    return null;
  }
  const pages = /^(?:src\/)?pages\/(.*)$/.exec(noExt);
  if (pages) {
    const segs = pages[1]!.split('/');
    if (segs[0] === 'api') {
      const pattern = segmentsToPattern(segs);
      return pattern ? { kind: 'api', pattern } : null;
    }
    if (segs.at(-1)!.startsWith('_')) return null; // _app, _document
    return { kind: 'page' };
  }
  return null;
}

export function joinRoute(prefix: string, p: string): string {
  const segs = `${prefix}/${p}`.split('/').filter(Boolean);
  return '/' + segs.join('/');
}

/**
 * How well a called URL matches a route pattern (higher is better), or -1 if it doesn't.
 * `:x` route segments match anything; `:param` call segments (dynamic parts) match anything;
 * `*` matches one or more trailing segments and `*?` zero or more.
 */
export function matchRoute(call: string, route: string): number {
  const cs = call.split('/').filter(Boolean);
  const rs = route.split('/').filter(Boolean);
  let score = 0;
  for (let i = 0; i < rs.length; i++) {
    const r = rs[i]!;
    if (r === '*' || r === '*?') {
      if (r === '*' && i >= cs.length) return -1;
      return score + 0.5;
    }
    const c = cs[i];
    if (c === undefined) return -1;
    if (r === c) score += 3;
    else if (r.startsWith(':')) score += 2;
    else if (c === ':param') score += 1;
    else return -1;
  }
  return cs.length === rs.length ? score : -1;
}
