import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import react from '@vitejs/plugin-react';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(dirname, './src'),
      '@funny/client-core/stores/circuit-breaker': path.resolve(
        dirname,
        '../client-core/src/stores/circuit-breaker.ts',
      ),
      '@funny/client-core/stores/preferences': path.resolve(
        dirname,
        '../client-core/src/stores/preferences.ts',
      ),
      '@funny/client-core/stores/thread-read': path.resolve(
        dirname,
        '../client-core/src/stores/thread-read.ts',
      ),
      '@funny/client-core': path.resolve(dirname, '../client-core/src/index.ts'),
    },
  },
  // Unit tests run on `bun test` (bunfig.toml). Only the Storybook
  // interaction tests, which need a real browser, stay on vitest.
  test: {
    projects: [
      // Storybook interaction tests (browser)
      {
        extends: true,
        plugins: [
          storybookTest({
            configDir: path.join(dirname, '.storybook'),
          }),
        ],
        test: {
          name: 'storybook',
          browser: {
            enabled: true,
            provider: playwright({}),
            headless: true,
            instances: [{ browser: 'chromium' }],
          },
          setupFiles: ['./.storybook/vitest.setup.ts'],
        },
      },
    ],
  },
});
