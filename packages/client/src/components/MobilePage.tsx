import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { ChatView } from '@/components/mobile/ChatView';
import { NewThreadView } from '@/components/mobile/NewThreadView';
import { ProjectListView } from '@/components/mobile/ProjectListView';
import { ThreadListView } from '@/components/mobile/ThreadListView';
import { Toaster } from '@/components/ui/sonner';
import { useWS } from '@/hooks/use-ws';
import { TOAST_DURATION } from '@/lib/utils';
import { useAppStore } from '@/stores/app-store';

type MobileView =
  | { screen: 'projects' }
  | { screen: 'threads'; projectId: string }
  | { screen: 'chat'; projectId: string; threadId: string }
  | { screen: 'newThread'; projectId: string };

export function MobilePage() {
  const [view, setView] = useState<MobileView>({ screen: 'projects' });
  const [ready, setReady] = useState(false);

  const loadProjects = useAppStore((s) => s.loadProjects);
  const projects = useAppStore((s) => s.projects);

  useWS();

  useEffect(() => {
    loadProjects().finally(() => setReady(true));
  }, [loadProjects]);

  if (!ready) {
    return (
      <div className="flex h-[100dvh] items-center justify-center bg-background text-foreground">
        <Loader2 className="icon-xl animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <>
      <div className="flex h-[100dvh] flex-col overflow-hidden bg-background text-foreground">
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
              setView({ screen: 'chat', projectId: view.projectId, threadId })
            }
            onNewThread={() => setView({ screen: 'newThread', projectId: view.projectId })}
          />
        )}
        {view.screen === 'newThread' && (
          <NewThreadView
            projectId={view.projectId}
            onBack={() => setView({ screen: 'threads', projectId: view.projectId })}
            onCreated={(threadId) =>
              setView({ screen: 'chat', projectId: view.projectId, threadId })
            }
          />
        )}
        {view.screen === 'chat' && (
          <ChatView
            projectId={view.projectId}
            threadId={view.threadId}
            onBack={() => setView({ screen: 'threads', projectId: view.projectId })}
          />
        )}
      </div>
      <Toaster position="top-center" duration={TOAST_DURATION} />
    </>
  );
}
