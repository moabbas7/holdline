/**
 * Whether Playwright and its Chromium are installed. Tests that need a browser use
 * `describe.skipIf(!PLAYWRIGHT)` and print why they were skipped.
 */
import { createRequire } from 'node:module';

async function check(): Promise<string | null> {
  let chromium: { launch(o?: object): Promise<{ close(): Promise<void> }> };
  try {
    ({ chromium } = createRequire(import.meta.url)('playwright'));
  } catch {
    return 'Playwright is not installed';
  }
  try {
    const b = await chromium.launch({ headless: true });
    await b.close();
    return null;
  } catch {
    return "Playwright's Chromium is not installed";
  }
}

const reason = await check();
export const PLAYWRIGHT = reason === null;
if (reason) {
  console.warn(`Skipping browser tests: ${reason}. Run \`npm install && npx playwright install chromium\` to run them.`);
}
