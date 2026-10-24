import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `pnpm test:coverage` runs the unit project with these settings.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      reporter: ['text', 'text-summary', 'html', 'json-summary'],
      reportsDirectory: 'coverage',
      // A floor a few points under the measured values (72.9 / 62.5 / 72.6 / 77.1 when set):
      // raise these as coverage grows, never lower them.
      thresholds: {
        statements: 70,
        branches: 60,
        functions: 70,
        lines: 74,
      },
    },
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/**/*.test.{ts,tsx}'],
          exclude: [...configDefaults.exclude, 'test/e2e/**'],
          // Keeps the developer's own ~/.guided-review (and any GitHub token it names) out of unit tests.
          setupFiles: ['test/helpers/isolateHome.ts'],
          // Screen tests press keys one frame at a time; under coverage on a CI runner, a long walk
          // takes past vitest's default five seconds.
          testTimeout: 15_000,
        },
      },
      {
        // Drives the built `gr` binary in a pseudo-terminal; see test/e2e/harness.ts.
        test: {
          name: 'e2e',
          include: ['test/e2e/**/*.e2e.test.ts'],
          globalSetup: ['test/e2e/globalSetup.ts'],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
