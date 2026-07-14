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
  t: TFunction;
  onSend: (prompt: string, opts: { model: string; mode: string }) => void;
  onPermissionApprove: () => void;
  onPermissionAlwaysAllow: () => void;
  onPermissionDeny: () => void;
  onPermissionDecision?: (requestId: string, decision: PermissionDecision) => Promise<void> | void;
}

export function MessageStreamStatusTail({
  status,
  waitingReason,
  pendingPermission,
  pendingPermissionRequest,
  permissionApprovalCapability,
  permissionRecoveryReason,
  isRunning,
  isExternal,
  compact,
  resultInfo,
  model,
  permissionMode,
  t,
  onSend,
  onPermissionApprove,
  onPermissionAlwaysAllow,
  onPermissionDeny,
  onPermissionDecision,
}: MessageStreamStatusTailProps) {
  const sendContinue = () => onSend('Continue', { model, mode: permissionMode });
  const sendWithMode = (text: string) => onSend(text, { model, mode: permissionMode });

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

      {status === 'waiting' && waitingReason === 'question' && (
        <StatusBlock className="text-status-warning/80 flex items-center gap-2 text-xs">
          <Clock className="size-3.5 text-yellow-400" />
          {t('thread.waitingForResponse')}
        </StatusBlock>
      )}

      {status === 'waiting' &&
        waitingReason === 'permission' &&
        pendingPermissionRequest &&
        permissionApprovalCapability?.kind === 'structured' && (
          <StatusBlock>
            <PermissionApprovalCard
              toolName={pendingPermissionRequest.toolName}
              toolInput={pendingPermissionRequest.toolInput}
              onApprove={() =>
                onPermissionDecision?.(pendingPermissionRequest.requestId, 'allow_once')
              }
              onAlwaysAllow={
                pendingPermissionRequest.canAlwaysAllow
                  ? () => onPermissionDecision?.(pendingPermissionRequest.requestId, 'allow_always')
                  : undefined
              }
              onDeny={
                pendingPermissionRequest.canDeny
                  ? () => onPermissionDecision?.(pendingPermissionRequest.requestId, 'deny')
                  : undefined
              }
            />
          </StatusBlock>
        )}

      {status === 'waiting' && permissionRecoveryReason === 'runner_lost' && (
        <StatusBlock>
          <PermissionContinuationLostCard />
        </StatusBlock>
      )}

      {status === 'waiting' &&
        (waitingReason === 'permission' || waitingReason === 'provider_error') &&
        permissionRecoveryReason !== 'runner_lost' &&
        permissionApprovalCapability?.kind === 'unavailable' && (
          <StatusBlock>
            <CodexSdkApprovalUnavailableCard />
          </StatusBlock>
        )}

      {status === 'waiting' &&
        waitingReason === 'permission' &&
        pendingPermission &&
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

      {status === 'waiting' &&
        waitingReason === 'provider_error' &&
        permissionApprovalCapability?.kind !== 'unavailable' && (
          <StatusBlock>
            <ProviderErrorCard onSend={sendWithMode} />
          </StatusBlock>
        )}

      {status === 'waiting' && !waitingReason && (
        <StatusBlock>
          <WaitingActions onSend={sendWithMode} />
        </StatusBlock>
      )}

      {resultInfo && !isRunning && status !== 'stopped' && status !== 'interrupted' && (
        <StatusBlock>
          <AgentResultCard
            status={resultInfo.status}
            cost={resultInfo.cost}
            duration={resultInfo.duration}
            error={resultInfo.error}
            onContinue={resultInfo.status === 'failed' ? sendContinue : undefined}
          />
        </StatusBlock>
      )}

      {status === 'interrupted' && (
        <StatusBlock>
          <AgentInterruptedCard onContinue={sendContinue} />
        </StatusBlock>
      )}

      {status === 'stopped' && (
        <StatusBlock>
          <AgentStoppedCard onContinue={sendContinue} />
        </StatusBlock>
      )}
    </>
  );
}

function StatusBlock({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={className}>{children}</div>;
}
