import { describe, expect, it } from 'vitest';
import type { DepGraph } from '../../src/probes/dependencies/types.js';
import type { ProbeReport } from '../../src/probes/types.js';
import { classify, severityOf } from '../../src/scope/classify.js';
import { matchTask, matchesScopeGlob } from '../../src/scope/taskScope.js';
import { extractTerms, singular, subwords } from '../../src/scope/terms.js';

describe('task terms', () => {
  it('extracts paths, routes, names, words and phrases; drops stop words and generic words', () => {
    const terms = extractTerms('Add a tooltip to the link card copy button in `components/LinkCard.tsx` and fix /api/links/[id], see formatDate');
    const by = (k: string) => terms.filter((t) => t.kind === k).map((t) => t.text);
    expect(by('path')).toEqual(['components/LinkCard.tsx']);
    expect(by('route')).toEqual(['/api/links/[id]']);
    expect(by('name')).toEqual(['formatDate']);
    expect(by('word')).toEqual(expect.arrayContaining(['tooltip', 'link', 'card', 'copy', 'date']));
    expect(by('word')).not.toContain('button'); // generic alone…
    expect(by('phrase')).toEqual(expect.arrayContaining(['link card', 'card copy button', 'copy button'])); // …but kept in phrases
    expect(by('word')).not.toContain('add');
    expect(by('word')).not.toContain('the');
  });

  it("drops possessives: \"timeAgo's option\" names timeAgo", () => {
    expect(extractTerms("rename timeAgo's withAgo option").filter((t) => t.kind === 'name').map((t) => t.text)).toEqual(['timeAgo', 'withAgo']);
  });

  it('a probe running out of analysis time is a note, not a change outside the task', () => {
    const scope = matchTask('anything', [], { files: [], graph: null });
    const reports: ProbeReport[] = [
      { probeId: 'api', title: 'API', status: 'changed', summary: '', findings: [{ kind: 'change', title: '/api/x can no longer be analysed (analysis time budget (60s) exceeded); its responses are not compared', meta: { routes: ['/api/x'] } }] },
    ];
    const c = classify({ scope, beforeFiles: [], afterFiles: [], beforeGraph: null, afterGraph: null, edited: [], reports });
    expect(c.findings[0]!.severity).toBe('info');
  });

  it('is deterministic', () => {
    const task = 'Add pagination to /users and update UserCard';
    expect(JSON.stringify(extractTerms(task))).toBe(JSON.stringify(extractTerms(task)));
  });

  it('folds plurals and splits identifiers', () => {
    expect(['users', 'categories', 'addresses', 'status', 'boxes'].map(singular)).toEqual(['user', 'category', 'address', 'status', 'box']);
    expect(subwords('UserCard')).toEqual(['user', 'card']);
    expect(subwords('link-card.tsx')).toEqual(['link', 'card', 'tsx']);
    expect(subwords('APIKeyList')).toEqual(['api', 'key', 'list']);
  });
});

describe('matching the task against the project', () => {
  const files = ['app/users/page.tsx', 'app/billing/page.tsx', 'components/UserCard.tsx', 'components/user-avatar.tsx', 'lib/format.ts'];
  it('matches words against path segments and names against file names', () => {
    const s = matchTask('make UserCard bold', [], { files, graph: null });
    const name = s.terms.find((t) => t.kind === 'name')!;
    expect(name.files).toEqual(['components/UserCard.tsx']);
    const user = s.terms.find((t) => t.text === 'user')!;
    expect(user.files).toEqual(['app/users/page.tsx', 'components/UserCard.tsx', 'components/user-avatar.tsx']);
  });

  it('drops a word that matches too much of the project', () => {
    const many = Array.from({ length: 40 }, (_, i) => `app/links/l${i}.tsx`);
    const s = matchTask('add a tooltip to links', [], { files: [...files, ...many], graph: null });
    const links = s.terms.find((t) => t.text === 'links')!;
    expect(links.dropped).toMatch(/^matches 40 files/);
  });

  it('matches route names to API routes and pages', () => {
    const graph = { routes: { '/api/users': { files: ['app/api/users/route.ts'], methods: ['GET'] } }, tables: {} } as unknown as DepGraph;
    const s = matchTask('paginate /api/users and /users', [], { files: [...files, 'app/api/users/route.ts'], graph });
    expect(s.terms.find((t) => t.text === '/api/users')!.files).toEqual(['app/api/users/route.ts']);
    expect(s.terms.find((t) => t.text === '/users')!.files).toEqual(['app/users/page.tsx']);
  });

  it('--scope globs: wildcards, and plain folders', () => {
    expect(matchesScopeGlob('app/users/page.tsx', 'app/users/**')).toBe(true);
    expect(matchesScopeGlob('app/users/page.tsx', 'app/*/page.tsx')).toBe(true);
    expect(matchesScopeGlob('app/billing/page.tsx', 'app/users/**')).toBe(false);
    expect(matchesScopeGlob('lib/format.ts', 'lib')).toBe(true);
    expect(matchesScopeGlob('lib/format.ts', './lib/')).toBe(true);
    expect(matchesScopeGlob('library/x.ts', 'lib')).toBe(false);
  });
});

describe('classify', () => {
  const graph = {
    version: 1,
    files: { 'app/billing/page.tsx': { hash: 'a', role: 'page' }, 'lib/db.ts': { hash: 'b', role: 'module' } },
    routes: {},
    tables: { users: { definedIn: ['schema.sql'] } },
    edges: [{ from: 'app/billing/page.tsx', to: 'table:users', type: 'uses-table' }],
    broken: [],
    unmatchedCalls: [],
    stats: {},
  } as unknown as DepGraph;
  const files = ['app/billing/page.tsx', 'lib/db.ts', 'schema.sql'];

  it('a regression in a task table that code outside the task still uses is outside scope', () => {
    const scope = matchTask('rename the users email column', [], { files, graph });
    const reports: ProbeReport[] = [
      {
        probeId: 'database',
        title: 'Database schema',
        status: 'regressed',
        summary: '',
        findings: [{ kind: 'regression', title: 'Column users.email was dropped [live database]', meta: { tables: ['users'], affects: ['app/billing/page.tsx'] } }],
      },
    ];
    const c = classify({ scope, beforeFiles: files, afterFiles: files, beforeGraph: graph, afterGraph: graph, edited: [], reports });
    expect(c.findings[0]!.scope).toBe('outside-scope');
    expect(c.findings[0]!.reason).toBe('table users matches "users" in the task, but app/billing/page.tsx outside the task still uses it');
  });

  it('findings that name nothing are shown outside scope, so they are never hidden', () => {
    const scope = matchTask('rename the users email column', [], { files, graph });
    const reports: ProbeReport[] = [
      { probeId: 'checks', title: 'Checks', status: 'regressed', summary: '', findings: [{ kind: 'regression', title: 'test: passed before, fails now', detail: 'npm test\n1 failing\n(full log: x.log)' }] },
    ];
    const c = classify({ scope, beforeFiles: files, afterFiles: files, beforeGraph: graph, afterGraph: graph, edited: [], reports });
    expect(c.findings[0]!.scope).toBe('outside-scope');
    expect(c.findings[0]!.reason).toBe("the output doesn't name a project file, so holdline can't tell whether it is part of the task; shown so it isn't missed");
  });

  it('severity: checks and imports, then database and API, then visual, then changes', () => {
    expect(severityOf('checks', 'regression')).toBe('critical');
    expect(severityOf('dependencies', 'regression')).toBe('critical');
    expect(severityOf('database', 'regression')).toBe('high');
    expect(severityOf('api', 'regression')).toBe('high');
    expect(severityOf('visual', 'regression')).toBe('medium');
    expect(severityOf('visual', 'change')).toBe('low');
    expect(severityOf('files', 'info')).toBe('info');
  });
});
