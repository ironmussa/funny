import path from 'path';

import { defineConfig } from 'vitest/config';

const shared = path.resolve(__dirname, '../shared/src');
const pipelines = path.resolve(__dirname, '../pipelines/src');

export default defineConfig({
  resolve: {
    alias: {
      '@funny/shared/errors': path.join(shared, 'errors.ts'),
      '@funny/shared/models': path.join(shared, 'models.ts'),
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
      '@funny/shared': path.join(shared, 'types.ts'),
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
    include: ['src/**/*.test.ts'],
    exclude: [
      'dist/**',
      // Tests that depend on bun:sqlite (via test-db.ts helper or direct DB imports)
      'src/__tests__/db/**',
      'src/__tests__/routes/projects.test.ts',
      'src/__tests__/routes/git.test.ts',
      'src/__tests__/routes/threads.test.ts',
      'src/__tests__/services/project-manager.test.ts',
      'src/__tests__/services/thread-manager.test.ts',
      'src/__tests__/services/worktree-manager.test.ts',
      'src/__tests__/services/agent-runner.test.ts',
      'src/__tests__/services/agent-runner-class.test.ts',
      'src/__tests__/services/automation-manager.test.ts',
      'src/__tests__/services/pipeline-db.test.ts',
      // Tests that depend on Bun.spawn / Bun runtime
      'src/__tests__/utils/process.test.ts',
      'src/__tests__/utils/git-v2.test.ts',
    ],
  },
});
