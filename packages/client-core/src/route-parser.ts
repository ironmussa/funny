export interface ParsedClientRoute {
  orgSlug: string | null;
  settingsPage: string | null;
  preferencesPage: string | null;
  projectId: string | null;
  threadId: string | null;
  globalSearch: boolean;
  inbox: boolean;
  analytics: boolean;
  workflowsProjectId: string | null;
  liveColumns: boolean;
  addProject: boolean;
  designId: string | null;
  designsList: boolean;
  scheduler: boolean;
  scratchNew: boolean;
  externalClaudeSessionId: string | null;
}

const STATIC_ROUTES = new Set([
  'projects',
  'settings',
  'preferences',
  'inbox',
  'list',
  'kanban',
  'analytics',
  'grid',
  'new',
  'invite',
  'scratch',
  'external',
]);

function stripOrgPrefix(pathname: string): [string | null, string] {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 0) return [null, '/'];
  const potentialSlug = segments[0] ?? '';
  if (STATIC_ROUTES.has(potentialSlug)) return [null, pathname];
  return [potentialSlug, `/${segments.slice(1).join('/')}` || '/'];
}

function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const patternSegments = pattern.split('/').filter(Boolean);
  const pathSegments = pathname.split('/').filter(Boolean);
  if (patternSegments.length !== pathSegments.length) return null;
  const parameters: Record<string, string> = {};
  for (let index = 0; index < patternSegments.length; index++) {
    const patternSegment = patternSegments[index] ?? '';
    const pathSegment = pathSegments[index] ?? '';
    if (patternSegment.startsWith(':')) parameters[patternSegment.slice(1)] = pathSegment;
    else if (patternSegment !== pathSegment) return null;
  }
  return parameters;
}

function blank(orgSlug: string | null): ParsedClientRoute {
  return {
    orgSlug,
    settingsPage: null,
    preferencesPage: null,
    projectId: null,
    threadId: null,
    globalSearch: false,
    inbox: false,
    analytics: false,
    workflowsProjectId: null,
    liveColumns: false,
    addProject: false,
    designId: null,
    designsList: false,
    scheduler: false,
    scratchNew: false,
    externalClaudeSessionId: null,
  };
}

export function parseClientRoute(pathname: string): ParsedClientRoute {
  const [orgSlug, path] = stripOrgPrefix(pathname);
  const result = blank(orgSlug);
  const preferences = matchPath('/preferences/:pageId', path);
  if (preferences) return { ...result, preferencesPage: preferences.pageId ?? null };
  const legacyWorkflows = matchPath('/projects/:projectId/settings/workflows', path);
  if (legacyWorkflows) {
    return {
      ...result,
      projectId: legacyWorkflows.projectId ?? null,
      workflowsProjectId: legacyWorkflows.projectId ?? null,
    };
  }
  const projectSettings = matchPath('/projects/:projectId/settings/:pageId', path);
  if (projectSettings) {
    return {
      ...result,
      projectId: projectSettings.projectId ?? null,
      settingsPage: projectSettings.pageId ?? null,
    };
  }
  const settings = matchPath('/settings/:pageId', path);
  if (settings) return { ...result, settingsPage: settings.pageId ?? null };
  const design = matchPath('/projects/:projectId/designs/:designId', path);
  if (design) {
    return {
      ...result,
      projectId: design.projectId ?? null,
      designId: design.designId ?? null,
    };
  }
  const designs = matchPath('/projects/:projectId/designs', path);
  if (designs) {
    return { ...result, projectId: designs.projectId ?? null, designsList: true };
  }
  const workflows = matchPath('/projects/:projectId/workflows', path);
  if (workflows) {
    return {
      ...result,
      projectId: workflows.projectId ?? null,
      workflowsProjectId: workflows.projectId ?? null,
    };
  }
  const thread = matchPath('/projects/:projectId/threads/:threadId', path);
  if (thread) {
    return {
      ...result,
      projectId: thread.projectId ?? null,
      threadId: thread.threadId ?? null,
    };
  }
  const project = matchPath('/projects/:projectId', path);
  if (project) return { ...result, projectId: project.projectId ?? null };
  if (path === '/inbox') return { ...result, inbox: true };
  if (path === '/list' || path === '/kanban') return { ...result, globalSearch: true };
  const projectAnalytics = matchPath('/projects/:projectId/analytics', path);
  if (projectAnalytics) {
    return { ...result, projectId: projectAnalytics.projectId ?? null, analytics: true };
  }
  if (path === '/analytics') return { ...result, analytics: true };
  if (path === '/grid') return { ...result, liveColumns: true };
  if (path === '/scheduler') return { ...result, scheduler: true };
  if (path === '/new') return { ...result, addProject: true };
  if (path === '/scratch/new') return { ...result, scratchNew: true };
  const externalSession = matchPath('/external/claude/:sessionId', path);
  if (externalSession) {
    return { ...result, externalClaudeSessionId: externalSession.sessionId ?? null };
  }
  const scratchThread = matchPath('/scratch/:threadId', path);
  if (scratchThread) return { ...result, threadId: scratchThread.threadId ?? null };
  return result;
}
