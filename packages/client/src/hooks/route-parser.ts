import { matchPath } from 'react-router-dom';

import { stripOrgPrefix } from '@/lib/url';

export type ParsedRoute = {
  orgSlug: string | null;
  settingsPage: string | null;
  preferencesPage: string | null;
  projectId: string | null;
  threadId: string | null;
  globalSearch: boolean;
  inbox: boolean;
  analytics: boolean;
  liveColumns: boolean;
  addProject: boolean;
  designId: string | null;
  designsList: boolean;
  orchestrator: boolean;
  scratchNew: boolean;
};

function blank(orgSlug: string | null): ParsedRoute {
  return {
    orgSlug,
    settingsPage: null,
    preferencesPage: null,
    projectId: null,
    threadId: null,
    globalSearch: false,
    inbox: false,
    analytics: false,
    liveColumns: false,
    addProject: false,
    designId: null,
    designsList: false,
    orchestrator: false,
    scratchNew: false,
  };
}

export function parseRoute(pathname: string): ParsedRoute {
  const [orgSlug, p] = stripOrgPrefix(pathname);

  const preferencesMatch = matchPath('/preferences/:pageId', p);
  if (preferencesMatch) {
    return { ...blank(orgSlug), preferencesPage: preferencesMatch.params.pageId! };
  }

  const projectSettingsMatch = matchPath('/projects/:projectId/settings/:pageId', p);
  if (projectSettingsMatch) {
    return {
      ...blank(orgSlug),
      settingsPage: projectSettingsMatch.params.pageId!,
      projectId: projectSettingsMatch.params.projectId!,
    };
  }

  const settingsMatch = matchPath('/settings/:pageId', p);
  if (settingsMatch) {
    return { ...blank(orgSlug), settingsPage: settingsMatch.params.pageId! };
  }

  const designMatch = matchPath('/projects/:projectId/designs/:designId', p);
  if (designMatch) {
    return {
      ...blank(orgSlug),
      projectId: designMatch.params.projectId!,
      designId: designMatch.params.designId!,
    };
  }

  const designsListMatch = matchPath('/projects/:projectId/designs', p);
  if (designsListMatch) {
    return {
      ...blank(orgSlug),
      projectId: designsListMatch.params.projectId!,
      designsList: true,
    };
  }

  const threadMatch = matchPath('/projects/:projectId/threads/:threadId', p);
  if (threadMatch) {
    return {
      ...blank(orgSlug),
      projectId: threadMatch.params.projectId!,
      threadId: threadMatch.params.threadId!,
    };
  }

  const projectMatch = matchPath('/projects/:projectId', p);
  if (projectMatch) {
    return { ...blank(orgSlug), projectId: projectMatch.params.projectId! };
  }

  if (p === '/inbox') return { ...blank(orgSlug), inbox: true };
  if (p === '/list') return { ...blank(orgSlug), globalSearch: true };
  if (p === '/kanban') return { ...blank(orgSlug), globalSearch: true };

  const projectAnalyticsMatch = matchPath('/projects/:projectId/analytics', p);
  if (projectAnalyticsMatch) {
    return {
      ...blank(orgSlug),
      projectId: projectAnalyticsMatch.params.projectId!,
      analytics: true,
    };
  }

  if (p === '/analytics') return { ...blank(orgSlug), analytics: true };
  if (p === '/grid') return { ...blank(orgSlug), liveColumns: true };
  if (p === '/orchestrator') return { ...blank(orgSlug), orchestrator: true };
  if (p === '/new') return { ...blank(orgSlug), addProject: true };
  if (p === '/scratch/new') return { ...blank(orgSlug), scratchNew: true };

  const scratchThreadMatch = matchPath('/scratch/:threadId', p);
  if (scratchThreadMatch) {
    return { ...blank(orgSlug), threadId: scratchThreadMatch.params.threadId! };
  }

  return blank(orgSlug);
}
