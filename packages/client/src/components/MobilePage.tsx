import { useEffect, useState } from 'react';

import { ChatView } from '@/components/mobile/ChatView';
import { NewThreadView } from '@/components/mobile/NewThreadView';
import { ProjectListView } from '@/components/mobile/ProjectListView';
import { ProjectSettingsView } from '@/components/mobile/ProjectSettingsView';
import { SearchView } from '@/components/mobile/SearchView';
import { ThreadListView } from '@/components/mobile/ThreadListView';
import { LoadingState } from '@/components/ui/loading-state';
import { Toaster } from '@/components/ui/sonner';
import { useMobileNavigation } from '@/hooks/use-mobile-navigation';
import { useMobileViewport } from '@/hooks/use-mobile-viewport';
import { useWS } from '@/hooks/use-ws';
import { TOAST_DURATION } from '@/lib/utils';
import { useAppStore } from '@/stores/app-store';
import { ThreadProvider } from '@/stores/thread-context';

export function MobilePage() {
  const viewportRef = useMobileViewport();
  const [ready, setReady] = useState(false);
  const {
    view,
    setView,
    searchQuery,
    setSearchQuery,
    searchCaseSensitive,
    setSearchCaseSensitive,
  } = useMobileNavigation(ready);

  const loadProjects = useAppStore((s) => s.loadProjects);
  const projects = useAppStore((s) => s.projects);

  useWS();

  useEffect(() => {
    loadProjects().finally(() => setReady(true));
  }, [loadProjects]);

  return (
    <>
      <div
        ref={viewportRef}
        data-testid="mobile-viewport"
        className="bg-background text-foreground fixed inset-x-0 top-0 flex h-dvh min-h-0 flex-col overflow-hidden pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]"
      >
        {!ready && <LoadingState testId="mobile-page-loading" />}
        {ready && view.screen === 'projects' && (
          <ProjectListView
            projects={projects}
            onSelect={(projectId) => setView({ screen: 'threads', projectId })}
          />
        )}
        {ready && view.screen === 'threads' && (
          <ThreadListView
            projectId={view.projectId}
            onBack={() => setView({ screen: 'projects' })}
            onSelectThread={(threadId) =>
              setView({ screen: 'chat', projectId: view.projectId, threadId, from: 'threads' })
            }
            onNewThread={() => setView({ screen: 'newThread', projectId: view.projectId })}
            onSearch={() => {
              // Fresh search each time the icon is tapped from the thread list.
              setView({ screen: 'search', projectId: view.projectId });
            }}
            onSettings={() => setView({ screen: 'settings', projectId: view.projectId })}
          />
        )}
        {ready && view.screen === 'settings' && (
          <ProjectSettingsView
            projectId={view.projectId}
            onBack={() => setView({ screen: 'threads', projectId: view.projectId })}
          />
        )}
        {ready && view.screen === 'search' && (
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
        {ready && view.screen === 'newThread' && (
          <ThreadProvider threadId={null}>
            <NewThreadView
              projectId={view.projectId}
              onBack={() => setView({ screen: 'threads', projectId: view.projectId })}
              onCreated={(threadId) =>
                setView(
                  { screen: 'chat', projectId: view.projectId, threadId, from: 'threads' },
                  true,
                )
              }
            />
          </ThreadProvider>
        )}
        {ready && view.screen === 'chat' && (
          <ThreadProvider threadId={view.threadId}>
            <ChatView
              projectId={view.projectId}
              threadId={view.threadId}
              onBack={() =>
                setView(
                  !view.projectId
                    ? { screen: 'projects' }
                    : view.from === 'search'
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
