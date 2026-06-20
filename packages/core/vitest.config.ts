import path from 'path';

import { defineConfig } from 'vitest/config';

const shared = path.resolve(__dirname, '../shared/src');

export default defineConfig({
  resolve: {
    alias: {
      'bun:test': 'vitest',
      '@funny/shared/errors': path.join(shared, 'errors.ts'),
      '@funny/shared/models': path.join(shared, 'models.ts'),
      '@funny/shared/provider-manifest': path.join(shared, 'provider-manifest.ts'),
      '@funny/shared/provider-manifests': path.join(shared, 'provider-manifests.ts'),
      '@funny/shared/provider-manifest-schema': path.join(shared, 'provider-manifest-schema.ts'),
      '@funny/shared/json-validation': path.join(shared, 'json-validation.ts'),
      '@funny/shared/funny-config-schema': path.join(shared, 'funny-config-schema.ts'),
      '@funny/shared/runner-protocol': path.join(shared, 'runner-protocol.ts'),
      '@funny/shared/thread-machine': path.join(shared, 'thread-machine.ts'),
      '@funny/shared': path.join(shared, 'types.ts'),
      '@funny/core/agents': path.resolve(__dirname, 'src/agents/index.ts'),
      '@funny/core/git': path.resolve(__dirname, 'src/git/index.ts'),
      '@funny/core/ports': path.resolve(__dirname, 'src/ports/index.ts'),
      '@funny/core': path.resolve(__dirname, 'src/index.ts'),
    },
  },
  test: {
    globals: true,
    include: ['src/__tests__/*.test.ts'],
    exclude: ['dist/**'],
    // Git suites share process.env (FUNNY_DISABLE_NATIVE_GIT) and temp dirs —
    // parallel file workers cause flaky cross-talk.
    fileParallelism: false,
  },
});
