import { useEffect, useState } from 'react';

import { ChatView } from '@/components/mobile/ChatView';
import { NewThreadView } from '@/components/mobile/NewThreadView';
import { ProjectListView } from '@/components/mobile/ProjectListView';
import { ProjectSettingsView } from '@/components/mobile/ProjectSettingsView';
import { SearchView } from '@/components/mobile/SearchView';
import { ThreadListView } from '@/components/mobile/ThreadListView';
import { LoadingState } from '@/components/ui/loading-state';
import { Toaster } from '@/components/ui/sonner';
import { parseRoute } from '@/hooks/route-parser';
import { useWS } from '@/hooks/use-ws';
import { TOAST_DURATION } from '@/lib/utils';
import { useAppStore } from '@/stores/app-store';
import { ThreadProvider } from '@/stores/thread-context';
import { setAppNavigate } from '@/stores/thread-store';

type MobileView =
  | { screen: 'projects' }
  | { screen: 'threads'; projectId: string }
  | { screen: 'search'; projectId: string }
  | { screen: 'settings'; projectId: string }
  | { screen: 'chat'; projectId: string; threadId: string; from: 'threads' | 'search' }
  | { screen: 'newThread'; projectId: string };

export function MobilePage() {
  const [view, setView] = useState<MobileView>({ screen: 'projects' });
  const [ready, setReady] = useState(false);

  // Search query/case state is lifted here so it survives navigating into a
  // result's chat and back — re-mounting SearchView would otherwise reset it,
  // dropping the user back into an empty search instead of their results.
  const [searchQuery, setSearchQuery] = useState('');
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);

  const loadProjects = useAppStore((s) => s.loadProjects);
  const projects = useAppStore((s) => s.projects);

  useWS();

  useEffect(() => {
    loadProjects().finally(() => setReady(true));
  }, [loadProjects]);

  // Mobile navigates via local view state, not react-router. Register a
  // navigate seam so store-driven navigation — e.g. the "View" action on the
  // agent-result toast — switches the mobile view instead of silently no-oping.
  useEffect(() => {
    setAppNavigate((path: string) => {
      const parsed = parseRoute(path);
      if (parsed.projectId && parsed.threadId) {
        setView({
          screen: 'chat',
          projectId: parsed.projectId,
          threadId: parsed.threadId,
          from: 'threads',
        });
      } else if (parsed.projectId) {
        setView({ screen: 'threads', projectId: parsed.projectId });
      }
    });
  }, []);

  if (!ready) {
    return (
      <div className="bg-background text-foreground flex h-dvh">
        <LoadingState testId="mobile-page-loading" />
      </div>
    );
  }

  return (
    <>
      <div className="bg-background text-foreground flex h-dvh flex-col overflow-hidden">
        {view.screen === 'projects' && (
          <ProjectListView
            projects={projects}
            onSelect={(projectId) => setView({ screen: 'threads', projectId })}
          />
        )}
        {view.screen === 'threads' && (
          <ThreadListView
            projectId={view.projectId}
            onBack={() => setView({ screen: 'projects' })}
            onSelectThread={(threadId) =>
              setView({ screen: 'chat', projectId: view.projectId, threadId, from: 'threads' })
            }
            onNewThread={() => setView({ screen: 'newThread', projectId: view.projectId })}
            onSearch={() => {
              // Fresh search each time the icon is tapped from the thread list.
              setSearchQuery('');
              setSearchCaseSensitive(false);
              setView({ screen: 'search', projectId: view.projectId });
            }}
            onSettings={() => setView({ screen: 'settings', projectId: view.projectId })}
          />
        )}
        {view.screen === 'settings' && (
          <ProjectSettingsView
            projectId={view.projectId}
            onBack={() => setView({ screen: 'threads', projectId: view.projectId })}
          />
        )}
        {view.screen === 'search' && (
          <SearchView
            projectId={view.projectId}
            query={searchQuery}
            onQueryChange={setSearchQuery}
            caseSensitive={searchCaseSensitive}
            onCaseSensitiveChange={setSearchCaseSensitive}
            onBack={() => setView({ screen: 'threads', projectId: view.projectId })}
            onSelectThread={(threadId) =>
              setView({ screen: 'chat', projectId: view.projectId, threadId, from: 'search' })
            }
          />
        )}
        {view.screen === 'newThread' && (
          <ThreadProvider threadId={null}>
            <NewThreadView
              projectId={view.projectId}
              onBack={() => setView({ screen: 'threads', projectId: view.projectId })}
              onCreated={(threadId) =>
                setView({ screen: 'chat', projectId: view.projectId, threadId, from: 'threads' })
              }
            />
          </ThreadProvider>
        )}
        {view.screen === 'chat' && (
          <ThreadProvider threadId={view.threadId}>
            <ChatView
              projectId={view.projectId}
              threadId={view.threadId}
              onBack={() =>
                setView(
                  view.from === 'search'
                    ? { screen: 'search', projectId: view.projectId }
                    : { screen: 'threads', projectId: view.projectId },
                )
              }
            />
          </ThreadProvider>
        )}
      </div>
      <Toaster position="top-center" duration={TOAST_DURATION} />
    </>
  );
}
