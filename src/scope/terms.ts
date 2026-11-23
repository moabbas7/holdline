/**
 * Turns a task description into terms to look for in the project. Deterministic and local:
 * no AI, no network. Paths, routes, component and identifier names are kept as written;
 * plain words are lower-cased and folded to singular; adjacent words also form phrases
 * ("link card" → matches link-card.tsx / LinkCard.tsx).
 */

export type TermKind = 'path' | 'route' | 'name' | 'phrase' | 'word';

export interface Term {
  /** As written in the task. */
  text: string;
  kind: TermKind;
  /** name/phrase/word: normalised sub-words (lower-case, singular). path/route: the path. */
  words: string[];
}

/** Grammar words and verbs that say what to do, not where: never terms, and they break phrases. */
const STOP = new Set(
  (
    'a an the and or but nor of to in on at by for from with without into onto over under about as is are was were be been being it its ' +
    'this that these those there here so if then than when where which who whom whose what why how also just only too very ' +
    'all any some each every no not more most less least other another such own same can could should would will shall may might must ' +
    'do does did done doing have has had make makes made use uses used using via per like please ' +
    'add adds added adding fix fixes fixed fixing update updates updated updating change changes changed changing ' +
    'create creates created creating remove removes removed removing delete deletes deleted deleting implement implements implemented ' +
    'refactor refactors refactored refactoring improve improves improved improving support supports supported ' +
    'rename renames renamed move moves moved replace replaces replaced clean cleanup tweak adjust ensure allow allows let lets ' +
    'show shows display displays render renders handle handles handling set sets get gets put puts keep keeps ' +
    'new old better proper properly correct correctly instead small big simple quick minor bug bugs issue issues problem ' +
    'feature features work works working broken break breaks i we you they our your their my me us them ' +
    'should into now currently already still again'
  ).split(/\s+/),
);

/**
 * Generic programming nouns: too common to mean anything alone, but they still count inside
 * a phrase ("copy button", "users page").
 */
const GENERIC = new Set(
  (
    'page pages component components button buttons file files api apis route routes endpoint endpoints function functions ' +
    'method methods test tests spec specs code type types interface style styles css ui ux view views screen screens ' +
    'lib libs util utils utility utilities helper helpers hook hooks src app apps index main module modules package packages ' +
    'data error errors message messages text value values item items list lists field fields input inputs form forms ' +
    'state props prop class classes option options config setting settings default defaults logic flow case cases ' +
    'server client backend frontend front back end side top bottom left right one two first last line lines'
  ).split(/\s+/),
);

const FILE_EXT = /\.(?:[cm]?[jt]sx?|css|scss|sass|less|sql|prisma|json|md|mdx|html?|vue|svelte|astro|ya?ml|toml|graphql|gql)$/i;

/** "users" → "user", "categories" → "category", "addresses" → "address". */
export function singular(w: string): string {
  if (w.length <= 3) return w;
  if (/ies$/.test(w) && w.length > 4) return w.slice(0, -3) + 'y';
  if (/(?:ss|us|is)$/.test(w)) return w;
  if (/(?:sses|xes|zes|ches|shes)$/.test(w)) return w.slice(0, -2);
  if (/s$/.test(w)) return w.slice(0, -1);
  return w;
}

/** Split an identifier or file/folder name into lower-case sub-words: UserCard → user, card. */
export function subwords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

export const norm = (w: string) => singular(w.toLowerCase());

export function isStopWord(w: string): boolean {
  return STOP.has(w.toLowerCase());
}
export function isGenericWord(w: string): boolean {
  const l = w.toLowerCase();
  return GENERIC.has(l) || GENERIC.has(singular(l));
}

export function extractTerms(task: string): Term[] {
  const terms: Term[] = [];
  const seen = new Set<string>();
  const push = (t: Term) => {
    const key = `${t.kind}\0${t.kind === 'path' || t.kind === 'route' ? t.text : t.words.join(' ')}`;
    if (seen.has(key)) return;
    seen.add(key);
    terms.push(t);
  };

  // Words in order, with breaks where a stop word, a path or punctuation sits between them.
  const sequence: (string | null)[] = [];
  const tokens = task.split(/\s+/).filter(Boolean);
  for (const raw of tokens) {
    let tok = raw.replace(/^[`'"({<]+|[`'")}>.,;:!?]+$/g, '');
    tok = tok.replace(/['’]s$/i, ''); // possessive: "timeAgo's" → "timeAgo"
    // Brackets belong to the token when balanced (/users/[id]), not as punctuation.
    while (tok.endsWith(']') && (tok.match(/\[/g)?.length ?? 0) < (tok.match(/\]/g)?.length ?? 0)) tok = tok.slice(0, -1).replace(/[`'")}>.,;:!?]+$/, '');
    while (tok.startsWith('[') && !tok.includes(']')) tok = tok.slice(1);
    if (!tok) {
      sequence.push(null);
      continue;
    }
    const looksPath = tok.includes('/') || FILE_EXT.test(tok);
    if (looksPath) {
      if (/^\/[\w\-[\]:.*/]*$/.test(tok) && !FILE_EXT.test(tok)) {
        push({ text: tok.replace(/\/+$/, '') || '/', kind: 'route', words: [] });
      } else {
        push({ text: tok.replace(/^\.\//, '').replace(/\/+$/, ''), kind: 'path', words: [] });
      }
      // The parts of a path also name the area (app/users → users).
      for (const part of tok.split(/[/.]/)) {
        const sw = subwords(part).map(norm).filter((w) => w.length >= 3 && !isStopWord(w) && !isGenericWord(w) && !/^\d+$/.test(w));
        for (const w of sw) push({ text: w, kind: 'word', words: [w] });
      }
      sequence.push(null);
      continue;
    }
    // CamelCase / PascalCase / snake_case / kebab-case identifiers: a name.
    const isName = /[a-z][A-Z]/.test(tok) || /^[A-Z][a-z0-9]+[A-Z]/.test(tok) || /[a-z0-9][_-][a-z0-9]/i.test(tok);
    if (isName) {
      const sw = subwords(tok);
      push({ text: tok, kind: 'name', words: sw.map(norm) });
      for (const w of sw.map(norm)) if (w.length >= 3 && !isStopWord(w) && !isGenericWord(w)) push({ text: w, kind: 'word', words: [w] });
      sequence.push(null);
      continue;
    }
    // Trailing punctuation ends a phrase.
    const breakAfter = /[.,;:!?)]$/.test(raw);
    for (const w of subwords(tok)) {
      if (isStopWord(w) || /^\d+$/.test(w)) sequence.push(null);
      else sequence.push(w);
    }
    if (breakAfter) sequence.push(null);
  }

  // Single words (not generic) and phrases of 2–3 adjacent words (generic words allowed).
  for (let i = 0; i < sequence.length; i++) {
    const w = sequence[i];
    if (!w) continue;
    if (w.length >= 3 && !isGenericWord(w)) push({ text: w, kind: 'word', words: [norm(w)] });
    for (const n of [2, 3]) {
      const slice = sequence.slice(i, i + n);
      if (slice.length === n && slice.every(Boolean)) {
        const words = slice as string[];
        push({ text: words.join(' '), kind: 'phrase', words: words.map(norm) });
      }
    }
  }
  return terms;
}
