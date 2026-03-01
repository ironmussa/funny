import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for e2e testing.
 * Assumes the dev servers (client :5173 + server :3001) are already running.
 *
 * Usage:
 *   bun run test:e2e          # run all e2e tests
 *   bun run test:e2e:ui       # open Playwright UI mode
 *   bun run codegen            # record a new test with codegen
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',

  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:5179',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  /* Do NOT start dev servers automatically — they should already be running via `bun run dev` */
});
