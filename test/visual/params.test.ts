import { afterEach, describe, expect, it } from 'vitest';
import { initCommand, suggestPages } from '../../src/commands/init.js';
import { loadConfig } from '../../src/core/config.js';
import { isPageTemplate, resolvePageTemplate, templateParams, visualSettings } from '../../src/probes/visual/types.js';
import { cleanupAll, fakeIo, makeRepo } from '../helpers/tmpRepo.js';

afterEach(() => cleanupAll());

describe('page templates and sample values', () => {
  it('fills [x], [...x], [[...x]] and :x segments', () => {
    const params = { locale: 'en', id: '1', slug: 'docs/getting started' };
    expect(resolvePageTemplate('/[locale]/pricing', params)).toEqual({ path: '/en/pricing' });
    expect(resolvePageTemplate('/users/:id', params)).toEqual({ path: '/users/1' });
    expect(resolvePageTemplate('/blog/[...slug]', params)).toEqual({ path: '/blog/docs/getting%20started' });
    expect(resolvePageTemplate('/help/[[...topic]]', params)).toEqual({ path: '/help' });
    expect(resolvePageTemplate('/[[...all]]', {})).toEqual({ path: '/' });
    expect(resolvePageTemplate('/[team]/[project]', { team: 'acme' })).toEqual({ missing: ['project'] });
    expect(isPageTemplate('/about')).toBe(false);
    expect(isPageTemplate('/[locale]')).toBe(true);
    expect(templateParams('/[locale]/blog/[...slug]/[[...rest]]')).toEqual([
      { name: 'locale', optional: false, catchAll: false },
      { name: 'slug', optional: false, catchAll: true },
      { name: 'rest', optional: true, catchAll: true },
    ]);
  });

  it('visual settings resolve configured templates and list the ones missing a value', () => {
    const s = visualSettings({
      pages: ['/', '/[locale]/pricing', { path: '/[locale]/users/[id]', mask: ['.avatar'] }, '/[locale]/blog/[slug]', '/en/pricing'],
      params: { locale: 'en', id: 1 },
    });
    expect(s.pages).toEqual([
      { path: '/', mask: [] },
      { path: '/en/pricing', mask: [], template: '/[locale]/pricing' },
      { path: '/en/users/1', mask: ['.avatar'], template: '/[locale]/users/[id]' },
    ]);
    expect(s.unresolved).toEqual([{ template: '/[locale]/blog/[slug]', missing: ['slug'] }]);
    expect(s.params).toEqual({ locale: 'en', id: '1' });
  });
});

describe('init suggests pages under dynamic segments', () => {
  function i18nApp() {
    const t = makeRepo();
    t.write('package.json', JSON.stringify({ name: 'i18n', scripts: { dev: 'next dev' }, dependencies: { next: '15.0.0', react: '19.0.0' } }));
    t.write('next.config.mjs', "export default { i18n: { locales: ['de', 'fr'], defaultLocale: 'de' } };\n");
    t.write('app/[locale]/page.tsx', 'export default function P() { return null; }\n');
    t.write('app/[locale]/pricing/page.tsx', 'export default function P() { return null; }\n');
    t.write('app/[locale]/blog/[slug]/page.tsx', 'export default function P() { return null; }\n');
    t.write('app/[locale]/docs/[[...path]]/page.tsx', 'export default function P() { return null; }\n');
    t.write('app/about/page.tsx', 'export default function P() { return null; }\n');
    t.commitAll('app');
    return t;
  }

  it('guesses locale values (from the Next.js config) and leaves pages that need a value out', async () => {
    const t = i18nApp();
    const s = await suggestPages(t.dir, 'nextjs');
    expect(s.params).toEqual({ locale: 'de' });
    expect(s.pages).toEqual(['/', '/about', '/[locale]', '/[locale]/pricing', '/[locale]/docs/[[...path]]']);
    expect(s.needValues).toEqual([{ template: '/[locale]/blog/[slug]', missing: ['slug'] }]);
  });

  it('--yes writes the guessable pages and params, and says which pages need a value', async () => {
    const t = i18nApp();
    const io = fakeIo();
    await initCommand(t.dir, { yes: true }, io);
    const visual = (await loadConfig(t.dir)).probes!.visual as Record<string, unknown>;
    expect(visual).toEqual({ enabled: false, pages: ['/', '/about', '/[locale]', '/[locale]/pricing', '/[locale]/docs/[[...path]]'], params: { locale: 'de' } });
    expect(io.logs.join('\n')).toContain('Not suggested (need a sample value): /[locale]/blog/[slug]. Add them to probes.visual.pages with values in probes.visual.params, e.g. { "slug": "…" }.');
    const settings = visualSettings(visual);
    expect(settings.pages.map((p) => p.path)).toEqual(['/', '/about', '/de', '/de/pricing', '/de/docs']);
  });

  it('asks for values it cannot guess when the user turns the check on', async () => {
    const t = i18nApp();
    const io = fakeIo({ interactive: true, answers: [true, true], inputs: ['hello-world'] });
    await initCommand(t.dir, {}, io);
    expect(io.prompts.some((p) => p.includes('Sample value for [slug] (used in /[locale]/blog/[slug])'))).toBe(true);
    const visual = (await loadConfig(t.dir)).probes!.visual as Record<string, unknown>;
    expect(visual.enabled).toBe(true);
    expect(visual.params).toEqual({ locale: 'de', slug: 'hello-world' });
    expect(visual.pages).toContain('/[locale]/blog/[slug]');
    expect(visualSettings(visual).pages.map((p) => p.path)).toContain('/de/blog/hello-world');
  });

  it('an empty answer skips those pages', async () => {
    const t = i18nApp();
    const io = fakeIo({ interactive: true, answers: [true, true], inputs: [''] });
    await initCommand(t.dir, {}, io);
    const visual = (await loadConfig(t.dir)).probes!.visual as Record<string, unknown>;
    expect(visual.pages).not.toContain('/[locale]/blog/[slug]');
    expect(visual.params).toEqual({ locale: 'de' });
  });

  it('falls back to "en" for a locale segment when the project sets no default', async () => {
    const t = makeRepo();
    t.write('package.json', JSON.stringify({ dependencies: { next: '15.0.0' } }));
    t.write('app/[lang]/page.tsx', 'export default function P() { return null; }\n');
    t.commitAll('app');
    expect((await suggestPages(t.dir, 'nextjs')).params).toEqual({ lang: 'en' });
  });
});
