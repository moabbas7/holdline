/**
 * Count agreement for everything holdline prints (terminal, HTML report, agent feedback).
 * Exactly 1 is singular; 0 and 2+ are plural. Irregular forms are passed in, never guessed.
 */

/** "0 pages", "1 page", "2 pages". `many` defaults to `one` + "s". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${agree(n, one, many)}`;
}

/** The form alone, for a verb or pronoun that agrees with n: agree(n, 'depends', 'depend'), agree(n, 'is', 'are'). */
export function agree(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}
