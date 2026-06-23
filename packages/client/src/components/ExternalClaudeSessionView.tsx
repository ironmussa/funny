import type { Message, ToolCall } from '@funny/shared';
import { Clock, FolderOpen, GitBranch } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { PromptInput } from '@/components/PromptInput';
import { MessageStream, type MessageStreamHandle } from '@/components/thread/MessageStream';
import { Badge } from '@/components/ui/badge';
import { LoadingState } from '@/components/ui/loading-state';
import { api } from '@/lib/api';
import type { ExternalClaudeTranscript } from '@/lib/api/system';
import { timeAgo } from '@/lib/thread-utils';
import { cn } from '@/lib/utils';
import { useProjectStore } from '@/stores/project-store';

type LoadState =
  | { status: 'loading'; transcript: null }
  | { status: 'ready'; transcript: ExternalClaudeTranscript }
  | { status: 'error'; transcript: null; message: string };

const POLL_INTERVAL_MS = 3000;

export function ExternalClaudeSessionView({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const streamRef = useRef<MessageStreamHandle>(null);
  const [state, setState] = useState<LoadState>({ status: 'loading', transcript: null });
  const projects = useProjectStore((s) => s.projects);

  const loadTranscript = useCallback(async () => {
    const result = await api.getExternalClaudeTranscript(sessionId);
    if (result.isErr()) {
      setState({
        status: 'error',
        transcript: null,
        message: result.error.friendlyMessage ?? result.error.message,
      });
      return;
    }
    setState({ status: 'ready', transcript: result.value.transcript });
  }, [sessionId]);

  useEffect(() => {
    setState({ status: 'loading', transcript: null });
    void loadTranscript();
  }, [loadTranscript]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      void loadTranscript();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, [loadTranscript]);

  const messages = useMemo(
    () => (state.transcript ? transcriptToMessages(state.transcript) : []),
    [state.transcript],
  );

  const project = useMemo(() => {
    if (!state.transcript?.cwd) return undefined;
    return projects.find((candidate) => candidate.path === state.transcript?.cwd);
  }, [projects, state.transcript?.cwd]);

  const handleSend = useCallback(() => {
    toast.info(
      t(
        'externalClaude.sendUnavailable',
        'External Claude Code sessions are read-only until attach/send support is available.',
      ),
    );
    return false;
  }, [t]);

  return (
    <div className="bg-background flex h-full min-h-0 w-full flex-col overflow-hidden">
      {state.status === 'loading' ? (
        <LoadingState
          className="min-h-0 flex-1"
          testId="external-claude-loading"
          label={t('externalClaude.loading')}
        />
      ) : state.status === 'error' ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <div className="max-w-md text-center">
            <h2 className="text-sm font-semibold">{t('externalClaude.notFound')}</h2>
            <p className="text-muted-foreground mt-2 text-sm">{state.message}</p>
          </div>
        </div>
      ) : (
        <>
          <ExternalClaudeHeader transcript={state.transcript} projectName={project?.name} />
          <MessageStream
            ref={streamRef}
            threadId={`external-claude:${state.transcript.sessionId}`}
            status="running"
            messages={messages}
            threadEvents={[]}
            compactionEvents={[]}
            initInfo={{
              tools: [],
              cwd: state.transcript.cwd ?? '',
              model: 'Claude Code',
            }}
            isExternal
            model="Claude Code"
            permissionMode=""
            onSend={handleSend}
            createdAt={state.transcript.startedAt ?? undefined}
            className="min-h-0 flex-1"
            footer={
              <PromptInput
                onSubmit={handleSend}
                running={false}
                queuedCount={0}
                placeholder={t('externalClaude.promptPlaceholder', 'Continue in Claude Code...')}
                threadOverride={{
                  provider: 'claude',
                  model: null,
                  permissionMode: 'auto',
                  branch: state.transcript.gitBranch,
                  baseBranch: state.transcript.gitBranch,
                  worktreePath: state.transcript.cwd,
                  projectId: project?.id,
                  queuedCount: 0,
                }}
              />
            }
          />
        </>
      )}
    </div>
  );
}

function ExternalClaudeHeader({
  transcript,
  projectName,
}: {
  transcript: ExternalClaudeTranscript;
  projectName?: string;
}) {
  const { t } = useTranslation();
  const updatedLabel = transcript.updatedAt ? timeAgo(transcript.updatedAt, t) : null;
  const title =
    transcript.title || projectName || transcript.projectName || t('externalClaude.title');

  return (
    <div className="border-border flex h-12 shrink-0 items-center border-b px-4 py-2">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-sm font-medium" data-testid="external-claude-title">
              {title}
            </h1>
            <Badge variant="outline" size="xxs" className="text-muted-foreground">
              {t('externalClaude.readOnlyBadge', 'Read-only')}
            </Badge>
          </div>
          <div className="text-muted-foreground mt-0.5 flex min-w-0 items-center gap-3 text-xs">
            <HeaderMeta icon={FolderOpen} label={projectName ?? transcript.projectName} />
            <HeaderMeta icon={GitBranch} label={transcript.gitBranch} />
            <HeaderMeta
              icon={Clock}
              label={
                updatedLabel
                  ? t('externalClaude.updatedLabel', {
                      time: updatedLabel,
                      defaultValue: 'Updated {{time}}',
                    })
                  : null
              }
              className="hidden sm:flex"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function HeaderMeta({
  icon: Icon,
  label,
  className,
}: {
  icon: typeof FolderOpen;
  label?: string | null;
  className?: string;
}) {
  if (!label) return null;
  return (
    <span className={cn('flex min-w-0 items-center gap-1', className)}>
      <Icon className="icon-xs shrink-0" />
      <span className="truncate">{label}</span>
    </span>
  );
}

function transcriptToMessages(transcript: ExternalClaudeTranscript): (Message & {
  toolCalls?: (ToolCall & { timestamp?: string })[];
})[] {
  return transcript.messages.map((message) => {
    const fallbackTimestamp =
      transcript.updatedAt ?? transcript.startedAt ?? new Date(0).toISOString();
    const timestamp = message.timestamp ?? fallbackTimestamp;
    return {
      id: message.id,
      threadId: `external-claude:${transcript.sessionId}`,
      role: message.role,
      content: message.content,
      timestamp,
      ...(message.toolCalls && message.toolCalls.length > 0
        ? {
            toolCalls: message.toolCalls.map((toolCall) => ({
              id: toolCall.id,
              messageId: message.id,
              name: toolCall.name,
              input: toolCall.input,
              output: toolCall.output,
              author: toolCall.author,
              timestamp: toolCall.timestamp ?? timestamp,
            })),
          }
        : {}),
    };
  });
}
