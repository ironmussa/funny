import type {
  PendingPermissionRequest,
  PermissionApprovalCapability,
  PermissionDecision,
  PermissionRecoveryReason,
  WaitingReason,
} from '@funny/shared';
import type { TFunction } from 'i18next';
import { Clock } from 'lucide-react';
import type { ReactNode } from 'react';

import { D4CAnimation } from '../D4CAnimation';
import { AgentResultCard, AgentInterruptedCard, AgentStoppedCard } from './AgentStatusCards';
import {
  CodexSdkApprovalUnavailableCard,
  PermissionContinuationLostCard,
  WaitingActions,
  PermissionApprovalCard,
  ProviderErrorCard,
} from './WaitingCards';

interface MessageStreamStatusTailProps {
  status: string;
  completedAt?: string | null;
  /** Timestamp of the latest user message — start of the run being summarized. */
  turnStartedAt?: string | null;
  /** Latest user message id — its turn's hover reveals the completion card. */
  turnId?: string;
  copyThreadId?: string;
  waitingReason?: WaitingReason;
  pendingPermission?: { toolName: string; toolInput?: string };
  pendingPermissionRequest?: PendingPermissionRequest;
  permissionApprovalCapability?: PermissionApprovalCapability;
  permissionRecoveryReason?: PermissionRecoveryReason;
  isRunning: boolean;
  isExternal: boolean;
  compact: boolean;
  resultInfo?: {
    status: 'completed' | 'failed';
    cost: number;
    duration: number;
    error?: string;
  };
  model: string;
  permissionMode: string;
  effort?: string;
  t: TFunction;
  onSend: (prompt: string, opts: { model: string; mode: string; effort?: string }) => void;
  onPermissionApprove: () => void;
  onPermissionAlwaysAllow: () => void;
  onPermissionDeny: () => void;
  onPermissionDecision?: (requestId: string, decision: PermissionDecision) => Promise<void> | void;
}

export function MessageStreamStatusTail(props: MessageStreamStatusTailProps) {
  const {
    status,
    isRunning,
    isExternal,
    compact,
    resultInfo,
    completedAt,
    turnStartedAt,
    turnId,
    copyThreadId,
    model,
    permissionMode,
    effort,
    t,
    onSend,
  } = props;
  const sendContinue = () => onSend('Continue', { model, mode: permissionMode, effort });

  return (
    <>
      {isRunning && !isExternal && (
        <StatusBlock className="text-muted-foreground flex items-center gap-2.5 py-1 text-sm">
          <D4CAnimation size={compact ? 'sm' : undefined} />
          <span className="text-xs">{t('thread.agentWorking')}</span>
        </StatusBlock>
      )}

      {isRunning && isExternal && (
        <StatusBlock className="text-muted-foreground flex items-center gap-2.5 py-1 text-sm">
          <div className="flex items-center gap-1">
            <span className="bg-muted-foreground/60 inline-block size-1.5 rounded-full" />
            <span className="bg-muted-foreground/60 inline-block size-1.5 rounded-full" />
            <span className="bg-muted-foreground/60 inline-block size-1.5 rounded-full" />
          </div>
          <span className="text-xs">{t('thread.runningExternally', 'Running externally...')}</span>
        </StatusBlock>
      )}

      {status === 'waiting' && <WaitingStatus {...props} />}

      {resultInfo && !isRunning && status !== 'stopped' && status !== 'interrupted' && (
        <StatusBlock sectionId={turnId}>
          <AgentResultCard
            status={resultInfo.status}
            revealForSection={turnId}
            startedAt={turnStartedAt}
            completedAt={completedAt}
            copyThreadId={copyThreadId}
            cost={resultInfo.cost}
            duration={resultInfo.duration}
            error={resultInfo.error}
            onContinue={resultInfo.status === 'failed' ? sendContinue : undefined}
          />
        </StatusBlock>
      )}

      {status === 'interrupted' && (
        <StatusBlock>
          <AgentInterruptedCard
            onContinue={sendContinue}
            startedAt={turnStartedAt}
            completedAt={completedAt}
            copyThreadId={copyThreadId}
          />
        </StatusBlock>
      )}

      {status === 'stopped' && (
        <StatusBlock>
          <AgentStoppedCard
            onContinue={sendContinue}
            startedAt={turnStartedAt}
            completedAt={completedAt}
            copyThreadId={copyThreadId}
          />
        </StatusBlock>
      )}
    </>
  );
}

type WaitingStatusProps = Pick<
  MessageStreamStatusTailProps,
  | 'waitingReason'
  | 'pendingPermission'
  | 'pendingPermissionRequest'
  | 'permissionApprovalCapability'
  | 'permissionRecoveryReason'
  | 't'
  | 'onSend'
  | 'model'
  | 'permissionMode'
  | 'onPermissionDecision'
  | 'onPermissionApprove'
  | 'onPermissionAlwaysAllow'
  | 'onPermissionDeny'
>;

function WaitingStatus(props: WaitingStatusProps) {
  const { waitingReason, permissionRecoveryReason, t, onSend, model, permissionMode } = props;
  const sendWithMode = (text: string) => onSend(text, { model, mode: permissionMode });
  return (
    <>
      {waitingReason === 'question' && (
        <StatusBlock className="text-status-warning/80 flex items-center gap-2 text-xs">
          <Clock className="size-3.5 text-yellow-400" />
          {t('thread.waitingForResponse')}
        </StatusBlock>
      )}

      {permissionRecoveryReason === 'runner_lost' && (
        <StatusBlock>
          <PermissionContinuationLostCard />
        </StatusBlock>
      )}
      {waitingReason === 'permission' && <WaitingPermissions {...props} />}

      {waitingReason === 'provider_error' && permissionRecoveryReason !== 'runner_lost' && (
        <StatusBlock>
          <ProviderErrorCard onSend={sendWithMode} />
        </StatusBlock>
      )}

      {!waitingReason && (
        <StatusBlock>
          <WaitingActions onSend={sendWithMode} />
        </StatusBlock>
      )}
    </>
  );
}

function StatusBlock({
  className,
  sectionId,
  children,
}: {
  className?: string;
  /** Marks the block as part of a turn so hovering it keeps that turn's bar shown. */
  sectionId?: string;
  children: ReactNode;
}) {
  return (
    <div className={className} data-turn-section={sectionId}>
      {children}
    </div>
  );
}

function StructuredApproval({
  request,
  onDecision,
}: {
  request: PendingPermissionRequest;
  onDecision: MessageStreamStatusTailProps['onPermissionDecision'];
}) {
  return (
    <StatusBlock>
      <PermissionApprovalCard
        toolName={request.toolName}
        toolInput={request.toolInput}
        onApprove={() => onDecision?.(request.requestId, 'allow_once')}
        onAlwaysAllow={
          request.canAlwaysAllow ? () => onDecision?.(request.requestId, 'allow_always') : undefined
        }
        onDeny={request.canDeny ? () => onDecision?.(request.requestId, 'deny') : undefined}
      />
    </StatusBlock>
  );
}

function WaitingPermissions({
  pendingPermission,
  pendingPermissionRequest,
  permissionApprovalCapability,
  permissionRecoveryReason,
  onPermissionDecision,
  onPermissionApprove,
  onPermissionAlwaysAllow,
  onPermissionDeny,
}: Pick<
  WaitingStatusProps,
  | 'pendingPermission'
  | 'pendingPermissionRequest'
  | 'permissionApprovalCapability'
  | 'permissionRecoveryReason'
  | 'onPermissionDecision'
  | 'onPermissionApprove'
  | 'onPermissionAlwaysAllow'
  | 'onPermissionDeny'
>) {
  return (
    <>
      {pendingPermissionRequest && permissionApprovalCapability?.kind === 'structured' && (
        <StructuredApproval request={pendingPermissionRequest} onDecision={onPermissionDecision} />
      )}

      {approvalUnavailable(permissionRecoveryReason, permissionApprovalCapability) && (
        <StatusBlock>
          <CodexSdkApprovalUnavailableCard />
        </StatusBlock>
      )}

      {pendingPermission &&
        permissionApprovalCapability?.kind !== 'unavailable' &&
        !pendingPermissionRequest && (
          <StatusBlock>
            <PermissionApprovalCard
              toolName={pendingPermission.toolName}
              toolInput={pendingPermission.toolInput}
              onApprove={onPermissionApprove}
              onAlwaysAllow={onPermissionAlwaysAllow}
              onDeny={onPermissionDeny}
            />
          </StatusBlock>
        )}
    </>
  );
}

function approvalUnavailable(
  recovery: PermissionRecoveryReason | undefined,
  capability: PermissionApprovalCapability | undefined,
) {
  return recovery !== 'runner_lost' && capability?.kind === 'unavailable';
}
