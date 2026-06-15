import path from 'path';

import { defineConfig } from 'vitest/config';

const shared = path.resolve(__dirname, '../shared/src');
const pipelines = path.resolve(__dirname, '../pipelines/src');
const evflow = path.resolve(__dirname, '../evflow/src');

export default defineConfig({
  resolve: {
    alias: {
      '@funny/shared/errors': path.join(shared, 'errors.ts'),
      '@funny/shared/models': path.join(shared, 'models.ts'),
      '@funny/shared/provider-manifest': path.join(shared, 'provider-manifest.ts'),
      '@funny/shared/provider-manifests': path.join(shared, 'provider-manifests.ts'),
      '@funny/shared/provider-manifest-schema': path.join(shared, 'provider-manifest-schema.ts'),
      '@funny/shared/thread-machine': path.join(shared, 'thread-machine.ts'),
      '@funny/shared/prompts': path.join(shared, 'prompts/index.ts'),
      '@funny/shared/db/schema-sqlite': path.join(shared, 'db/schema.sqlite.ts'),
      '@funny/shared/db/schema-pg': path.join(shared, 'db/schema.pg.ts'),
      '@funny/shared/db/columns': path.join(shared, 'db/columns.ts'),
      '@funny/shared/db/connection': path.join(shared, 'db/connection.ts'),
      '@funny/shared/db/db-mode': path.join(shared, 'db/db-mode.ts'),
      '@funny/shared/db/migrate': path.join(shared, 'db/migrate.ts'),
      '@funny/shared/repositories': path.join(shared, 'repositories/index.ts'),
      '@funny/shared/runner-protocol': path.join(shared, 'runner-protocol.ts'),
      '@funny/shared/socket-events': path.join(shared, 'socket-events.ts'),
      '@funny/shared/auth/forwarded-identity': path.join(shared, 'auth/forwarded-identity.ts'),
      '@funny/shared/auth/media-url-signature': path.join(shared, 'auth/media-url-signature.ts'),
      '@funny/shared/evflow-model': path.join(shared, 'evflow.model.ts'),
      '@funny/shared/lib/crypto': path.join(shared, 'lib/crypto.ts'),
      '@funny/shared': path.join(shared, 'types.ts'),
      '@funny/evflow': path.join(evflow, 'index.ts'),
      '@funny/pipelines/engine': path.join(pipelines, 'engine.ts'),
      '@funny/pipelines/pipelines/code-review.pipeline': path.join(
        pipelines,
        'pipelines/code-review.pipeline.ts',
      ),
      '@funny/pipelines/pipelines/commit.pipeline': path.join(
        pipelines,
        'pipelines/commit.pipeline.ts',
      ),
      '@funny/pipelines/pipelines/pre-push.pipeline': path.join(
        pipelines,
        'pipelines/pre-push.pipeline.ts',
      ),
      '@funny/pipelines/pipelines/code-quality.pipeline': path.join(
        pipelines,
        'pipelines/code-quality.pipeline.ts',
      ),
      '@funny/pipelines': path.join(pipelines, 'index.ts'),
      // Zod v4 ESM re-exports break Vite SSR transform; use CJS build instead
      zod: path.resolve(__dirname, 'node_modules/zod/index.cjs'),
    },
  },
  test: {
    coverage: {
      provider: 'istanbul',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/__tests__/**', 'dist/**'],
      thresholds: {
        lines: 32,
      },
    },
    include: ['src/**/*.test.ts'],
    exclude: ['dist/**'],
  },
});
