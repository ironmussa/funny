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
    },
  },
  test: {
    coverage: {
      provider: 'v8',
      // Measure testable logic layers — not every UI component shell.
      include: [
        'src/lib/**/*.{ts,tsx}',
        'src/stores/**/*.{ts,tsx}',
        'src/hooks/**/*.{ts,tsx}',
        'src/machines/**/*.{ts,tsx}',
      ],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/**/*.stories.{ts,tsx}',
        'src/__tests__/**',
        // Thin fetch wrappers / heavy browser integrations — covered by E2E instead.
        'src/lib/api/**',
        'src/lib/diff/**',
        'src/lib/monaco-setup.ts',
        'src/lib/file-search-worker-client.ts',
        'src/lib/file-index-db.ts',
        'src/lib/markdown-components.tsx',
        'src/lib/file-icons.tsx',
        // Dev-only or socket singleton — exercised via E2E / integration tests.
        'src/stores/test-store.ts',
        'src/stores/thread-history-store.ts',
        'src/hooks/use-ws.ts',
      ],
      thresholds: {
        lines: 42,
      },
    },
    projects: [
      // Existing unit tests (jsdom)
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'jsdom',
          include: ['src/**/*.test.{ts,tsx}'],
          setupFiles: ['./src/__tests__/setup.ts'],
          globals: true,
        },
      },
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
