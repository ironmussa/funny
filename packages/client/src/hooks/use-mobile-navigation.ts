import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { parseRoute } from '@/hooks/route-parser';
import { useOrgAutoSwitch } from '@/hooks/use-org-auto-switch';
import { setAppNavigate, setUrlThreadId } from '@/stores/thread-store';

export type MobileView =
  | { screen: 'projects' }
  | { screen: 'threads' | 'search' | 'settings' | 'newThread'; projectId: string }
  | { screen: 'chat'; projectId: string; threadId: string; from: 'threads' | 'search' };

/** The URL is the source of truth, including on reload and browser history traversal. */
export function useMobileNavigation(ready: boolean) {
  const location = useLocation();
  const navigate = useNavigate();
  const parsed = parseRoute(location.pathname);
  const params = new URLSearchParams(location.search);
  const projectId = parsed.projectId;
  let view: MobileView = { screen: 'projects' };
  if (parsed.threadId) {
    view = {
      screen: 'chat',
      projectId: projectId ?? '',
      threadId: parsed.threadId,
      from: params.get('from') === 'search' ? 'search' : 'threads',
    };
  } else if (projectId) {
    const screen = params.get('view');
    view = {
      projectId,
      screen: parsed.settingsPage
        ? 'settings'
        : screen === 'search' || screen === 'settings' || screen === 'newThread'
          ? screen
          : 'threads',
    };
  }

  setUrlThreadId(parsed.threadId);
  useOrgAutoSwitch(ready, parsed.orgSlug);
  useEffect(() => {
    setAppNavigate(navigate);
  }, [navigate]);

  function setView(next: MobileView, replace = false) {
    const prefix = parsed.orgSlug ? `/${parsed.orgSlug}` : '';
    let path = '/';
    const query = new URLSearchParams();
    if (next.screen !== 'projects') {
      path = `/projects/${next.projectId}`;
      if (next.screen === 'chat') {
        path = next.projectId ? `${path}/threads/${next.threadId}` : `/scratch/${next.threadId}`;
        if (next.from === 'search') query.set('from', 'search');
      } else if (next.screen !== 'threads') {
        query.set('view', next.screen);
      }
      if (next.screen === 'search' || (next.screen === 'chat' && next.from === 'search')) {
        for (const key of ['q', 'case']) {
          const value = params.get(key);
          if (value) query.set(key, value);
        }
      }
    }
    const search = query.toString();
    navigate(`${prefix}${path}${search ? `?${search}` : ''}`, { replace });
  }

  function setSearchParam(key: string, value: string) {
    const next = new URLSearchParams(location.search);
    if (value) next.set(key, value);
    else next.delete(key);
    navigate({ pathname: location.pathname, search: next.toString() }, { replace: true });
  }

  return {
    view,
    setView,
    searchQuery: params.get('q') ?? '',
    setSearchQuery: (value: string) => setSearchParam('q', value),
    searchCaseSensitive: params.get('case') === '1',
    setSearchCaseSensitive: (value: boolean) => setSearchParam('case', value ? '1' : ''),
  };
}
