import type { Hono } from 'hono';

import { mutationRateLimit } from '../middleware/rate-limit.js';
import { automationRoutes } from '../routes/automations.js';
import browseRoutes from '../routes/browse.js';
import { designProjectRoutes } from '../routes/designs.js';
import filesRoutes from '../routes/files.js';
import { gitRoutes } from '../routes/git.js';
import { githubRoutes } from '../routes/github.js';
import mcpRoutes from '../routes/mcp.js';
import { orchestratorRuntimeRoutes } from '../routes/orchestrator.js';
import { pipelineRuntimeRoutes } from '../routes/pipelines.js';
import pluginRoutes from '../routes/plugins.js';
import { projectRoutes } from '../routes/projects.js';
import skillsRoutes from '../routes/skills.js';
import { testRoutes } from '../routes/tests.js';
import { threadRoutes } from '../routes/threads.js';
import { worktreeRoutes } from '../routes/worktrees.js';

/**
 * Mounts every domain route module on the given Hono app and applies the
 * stricter mutation rate limit to mutation-heavy paths. Pulled out of app.ts
 * so the bootstrap file doesn't import all 14 route modules directly.
 */
export function registerRoutes(app: Hono): void {
  // Tiered rate limits: stricter limits for mutation-heavy endpoints
  app.use('/api/threads/*', mutationRateLimit());
  app.use('/api/git/*', mutationRateLimit());
  app.use('/api/worktrees/*', mutationRateLimit());

  app.route('/api/projects', projectRoutes);
  app.route('/api/threads', threadRoutes);
  app.route('/api/git', gitRoutes);
  app.route('/api/browse', browseRoutes);
  app.route('/api/files', filesRoutes);
  app.route('/api/mcp', mcpRoutes);
  app.route('/api/skills', skillsRoutes);
  app.route('/api/plugins', pluginRoutes);
  app.route('/api/worktrees', worktreeRoutes);
  app.route('/api/github', githubRoutes);
  app.route('/api/tests', testRoutes);
  app.route('/api/automations', automationRoutes);
  app.route('/api/pipelines', pipelineRuntimeRoutes);
  app.route('/api/orchestrator', orchestratorRuntimeRoutes);
  app.route('/api/projects', designProjectRoutes);
}
