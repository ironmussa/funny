/** Permission card and composer controls of the selected thread. */

import { IconButton } from '@funny/gpuix-ui/button';
import {
  ComposerActions,
  ComposerContext,
  PromptComposer,
  PromptEditorSurface,
} from '@funny/gpuix-ui/composer';
import { Icon } from '@funny/gpuix-ui/icon';
import { eventValue, Textarea } from '@funny/gpuix-ui/input';
import { PermissionCard as UiPermissionCard } from '@funny/gpuix-ui/status-card';
import { whilePending } from '@funny/shared/while-pending';
import { memo, useCallback, useState } from 'react';

import type { NativeApplicationServices } from '../application';
import {
  selectThreadPermission,
  selectThreadRun,
  selectThreadViewerShareLevel,
} from '../thread-render-selectors';
import { NativeButton, useNativeColors, useStoreValue } from './hooks';

export const PermissionCard = memo(function PermissionCard({
  threadId,
  application,
}: {
  threadId: string;
  application: NativeApplicationServices;
}) {
  const colors = useNativeColors();
  const permission = useStoreValue(
    application.workspaceState,
    useCallback((workspace) => selectThreadPermission(workspace, threadId), [threadId]),
  );
  const [pending, setPending] = useState(false);
  if (!permission) return null;
  const respond = async (decision: 'allow_once' | 'deny') => {
    if (pending || permission.status !== 'active') return;
    await whilePending(setPending, async () => {
      await application.commands.respondPermission({
        threadId,
        runId: permission.runId,
        requestId: permission.requestId,
        decision,
      });
    });
  };
  return (
    <UiPermissionCard
      testId={`permission-${permission.requestId}`}
      title={permission.status === 'active' ? 'Permission required' : 'Permission resolved'}
      detail={`${permission.toolName} · run ${permission.runId} · request ${permission.requestId}`}
      status={permission.status}
      tone="warning"
    >
      {permission.toolInput ? <code code={permission.toolInput} language="json" /> : null}
      <text style={{ color: colors.muted }}>
        Allowing this request may execute a tool with access to the current project environment.
      </text>
      <div style={{ display: 'flex', flexDirection: 'row', gap: 8 }}>
        <NativeButton
          onPress={() => {
            void respond('allow_once');
          }}
          disabled={pending || permission.status !== 'active'}
        >
          <text>Allow once</text>
        </NativeButton>
        <NativeButton
          onPress={() => {
            void respond('deny');
          }}
          disabled={pending || permission.status !== 'active'}
        >
          <text>Deny</text>
        </NativeButton>
      </div>
    </UiPermissionCard>
  );
});

export const ThreadControls = memo(function ThreadControls({
  threadId,
  application,
}: {
  threadId: string;
  application: NativeApplicationServices;
}) {
  const colors = useNativeColors();
  const run = useStoreValue(
    application.workspaceState,
    useCallback((workspace) => selectThreadRun(workspace, threadId), [threadId]),
  );
  const viewerShareLevel = useStoreValue(
    application.navigationState,
    useCallback((navigation) => selectThreadViewerShareLevel(navigation, threadId), [threadId]),
  );
  const [content, setContent] = useState('');
  const [pending, setPending] = useState(false);
  const canSteer = !viewerShareLevel || viewerShareLevel === 'steer';
  const active = ['setting_up', 'pending', 'running'].includes(run?.status ?? '');
  const waitingRunId = run?.status === 'waiting' && run.runId ? run.runId : null;
  const waiting = waitingRunId !== null;
  const lifecycle = !canSteer
    ? 'read-only'
    : pending
      ? 'pending'
      : active
        ? 'running'
        : waiting
          ? 'waiting'
          : 'idle';
  const submit = async (submittedContent = content) => {
    const trimmed = submittedContent.trim();
    if (!trimmed || pending || !canSteer) return;
    await whilePending(setPending, async () => {
      const ok = waitingRunId
        ? await application.commands.resumeRun({
            threadId,
            runId: waitingRunId,
            content: trimmed,
          })
        : await application.commands.submitPrompt({
            threadId,
            content: trimmed,
            optimisticMessage: {
              id: `native-${crypto.randomUUID()}`,
              threadId,
              role: 'user',
              content: trimmed,
              timestamp: new Date().toISOString(),
            },
          });
      if (ok) {
        setContent((current) => (current === submittedContent ? '' : current));
      }
    });
  };
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
        gap: 8,
        paddingTop: 8,
        paddingBottom: 12,
        paddingLeft: 16,
        paddingRight: 16,
        backgroundColor: colors.background,
      }}
    >
      <div style={{ width: '100%', maxWidth: 768, alignSelf: 'center' }}>
        <PermissionCard threadId={threadId} application={application} />
      </div>
      <PromptComposer lifecycle={lifecycle}>
        <PromptEditorSurface>
          <Textarea
            testId="thread-prompt"
            value={content}
            placeholder={canSteer ? 'Send a message…' : 'This shared thread is read-only'}
            readOnly={!canSteer}
            minRows={2}
            maxRows={7}
            style={{
              backgroundColor: colors.raised,
              borderWidth: 0,
              padding: 4,
            }}
            onValueChange={setContent}
            onSubmit={(event) => void submit(eventValue(event))}
          />
        </PromptEditorSurface>
        <ComposerActions>
          <ComposerContext>
            <text>{`Native · ${waiting ? 'Waiting' : active ? 'Running' : 'Auto Edit'}`}</text>
          </ComposerContext>
          <div style={{ display: 'flex', flexDirection: 'row', gap: 5 }}>
            {active ? (
              <IconButton
                testId="run-stop"
                label="Stop agent"
                variant="danger"
                icon={<Icon name="stop" />}
                onPress={() => void application.commands.stopRun(threadId)}
                disabled={application.commands.isStopPending(threadId)}
              />
            ) : null}
            <IconButton
              testId="prompt-submit"
              label={waiting ? 'Respond and resume' : 'Send message'}
              variant="primary"
              icon={<Icon name="send" color={colors.accentForeground} />}
              onPress={() => void submit()}
              disabled={!canSteer || pending || !content.trim()}
            />
          </div>
        </ComposerActions>
      </PromptComposer>
    </div>
  );
});
