import { getBaseUrlForThread, validateContainerUrl, type PullStrategy } from './api/_core';
import { agentTemplatesApi } from './api/agent-templates';
import { analyticsApi } from './api/analytics';
import { automationsApi } from './api/automations';
import { browseApi } from './api/browse';
import { designsApi } from './api/designs';
import { gitApi } from './api/git';
import { githubApi } from './api/github';
import { mcpApi } from './api/mcp';
import { orchestratorApi } from './api/orchestrator';
import { pipelinesApi } from './api/pipelines';
import { profileApi } from './api/profile';
import { projectsApi } from './api/projects';
import { skillsApi } from './api/skills';
import { systemApi } from './api/system';
import { teamApi } from './api/team';
import { testsApi } from './api/tests';
import { threadsApi } from './api/threads';
import { worktreesApi } from './api/worktrees';

// Re-export shared helpers/types consumed outside api.ts
export { getBaseUrlForThread, validateContainerUrl };
export type { PullStrategy };

// Order preserves the original section layout in api.ts so method ordering
// (in the merged object) matches pre-split behavior exactly.
export const api = {
  ...projectsApi, // Projects + Startup Commands + Project Config + Weave + Hooks
  ...threadsApi, // Threads + queue + comments
  ...gitApi, // Git (thread + project scoped) and Git Workflow
  ...mcpApi, // MCP Servers
  ...worktreesApi, // Worktrees
  ...skillsApi, // Skills + Plugins
  ...automationsApi, // Automations
  ...pipelinesApi, // Pipelines
  ...orchestratorApi, // Orchestrator queue
  ...agentTemplatesApi, // Agent Templates (per-user, Deep Agent only)
  ...browseApi, // Browse (filesystem)
  ...githubApi, // GitHub (status, OAuth, repos, issues, PRs, comments)
  ...analyticsApi, // Analytics + Logs
  ...systemApi, // Setup + System + Files
  ...profileApi, // Profile
  ...teamApi, // Team / Organization / Invites / Runners
  ...testsApi, // Test Runner
  ...designsApi, // Designs
};
