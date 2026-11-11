import path from 'path';

import { defineConfig } from 'vitest/config';

const shared = path.resolve(__dirname, '../shared/src');

export default defineConfig({
  resolve: {
    alias: {
      'bun:test': 'vitest',
      '@funny/shared/codex-commands': path.join(shared, 'codex-commands.ts'),
      '@funny/shared/errors': path.join(shared, 'errors.ts'),
      '@funny/shared/models': path.join(shared, 'models.ts'),
      '@funny/shared/provider-manifest': path.join(shared, 'provider-manifest.ts'),
      '@funny/shared/provider-manifests': path.join(shared, 'provider-manifests.ts'),
      '@funny/shared/provider-manifest-schema': path.join(shared, 'provider-manifest-schema.ts'),
      '@funny/shared/json-validation': path.join(shared, 'json-validation.ts'),
      '@funny/shared/funny-config-schema': path.join(shared, 'funny-config-schema.ts'),
      '@funny/shared/runner-protocol': path.join(shared, 'runner-protocol.ts'),
      '@funny/shared/thread-machine': path.join(shared, 'thread-machine.ts'),
      '@funny/shared/lib/child-env': path.join(shared, 'lib/child-env.ts'),
      '@funny/shared/async': path.join(shared, 'async.ts'),
      '@funny/shared/stale-while-revalidate': path.join(shared, 'stale-while-revalidate.ts'),
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
    // Files run in parallel: each runs in its own forked process (own
    // process.env, e.g. FUNNY_DISABLE_NATIVE_GIT) and its own temp dir, so the
    // git suites do not share state. Sequential runs took ~8 min instead of ~20 s.
  },
});
