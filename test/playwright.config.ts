import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: 1,
  workers: 1,
  reporter: [['list']],
  use: {
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Locally, run against the system Chrome install: the bundled
        // Chromium in this machine's Playwright cache is a broken stub that
        // will not launch, and reinstalling it does not repair it. CI
        // installs its own browsers (`playwright install chromium`), so it
        // keeps using the bundled build — `channel` is left unset there.
        channel: process.env.CI ? undefined : 'chrome',
      },
    },
  ],
});
