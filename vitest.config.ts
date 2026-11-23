import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    // git and process start-up are several times slower on Windows.
    testTimeout: process.platform === 'win32' ? 60_000 : 30_000,
    hookTimeout: process.platform === 'win32' ? 60_000 : 30_000,
  },
});
