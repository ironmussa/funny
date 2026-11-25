import { readThreadRow } from '@/data/threads/read';
import { showAgentNotification } from '@/hooks/use-notifications';
import { getThreadRoute, isScratch } from '@/lib/thread-variant';
import { buildPath } from '@/lib/url';
import { useThreadStore } from '@/stores/thread-store';
import { getNavigate } from '@/stores/thread-store-internals';
import { readActiveThreadView } from '@/stores/thread-view';

// Desktop notification for a finished or failed agent run.

function findThread(threadId: string): {
  title?: string;
  branch?: string;
  projectId?: string;
  isScratch?: boolean;
} {
  const active = readActiveThreadView(useThreadStore.getState());
  if (active?.id === threadId) {
    return {
      title: active.title,
      branch: active.branch,
      projectId: active.projectId,
      isScratch: active.isScratch,
    };
  }
  const t = readThreadRow(threadId);
  if (t) {
    return {
      title: t.title,
      branch: t.branch,
      projectId: t.projectId,
      isScratch: !!t.isScratch,
    };
  }
  return {};
}

function buildNotificationTitle(info: { title?: string; branch?: string }): string {
  const parts = ['funny'];
  if (info.branch) parts.push(info.branch);
  if (info.title) parts.push(info.title);
  return parts.join(' — ');
}

export function maybeNotifyAgentResult(threadId: string, data: any): void {
  const status = data.status as string | undefined;
  const info = findThread(threadId);
  const title = buildNotificationTitle(info);
  const onClick = () => {
    const navigate = getNavigate();
    if (!navigate) return;
    if (!isScratch(info) && !info.projectId) return;
    navigate(
      buildPath(
        getThreadRoute({
          id: threadId,
          projectId: info.projectId ?? '',
          isScratch: info.isScratch,
        }),
      ),
    );
  };
  if (status === 'completed') {
    showAgentNotification(title, 'Agent finished', {
      tag: `agent-result-${threadId}`,
      skipIfViewingThreadId: threadId,
      url: buildPath(
        getThreadRoute({
          id: threadId,
          projectId: info.projectId ?? '',
          isScratch: info.isScratch,
        }),
      ),
      onClick,
    });
  } else if (status === 'failed' || status === 'error') {
    const reason = data.errorReason ? ` — ${data.errorReason}` : '';
    showAgentNotification(title, `Agent failed${reason}`, {
      tag: `agent-result-${threadId}`,
      skipIfViewingThreadId: threadId,
      url: buildPath(
        getThreadRoute({
          id: threadId,
          projectId: info.projectId ?? '',
          isScratch: info.isScratch,
        }),
      ),
      onClick,
    });
  }
}
