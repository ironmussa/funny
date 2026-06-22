import type { WaitingReason } from '@funny/shared';
import type { TFunction } from 'i18next';
import { Clock } from 'lucide-react';
import { m } from 'motion/react';

import { D4CAnimation } from '../D4CAnimation';
import { AgentResultCard, AgentInterruptedCard, AgentStoppedCard } from './AgentStatusCards';
import { WaitingActions, PermissionApprovalCard, ProviderErrorCard } from './WaitingCards';

interface MessageStreamStatusTailProps {
  status: string;
  waitingReason?: WaitingReason;
  pendingPermission?: { toolName: string; toolInput?: string };
  isRunning: boolean;
  isExternal: boolean;
  compact: boolean;
  prefersReducedMotion: boolean | null;
  resultInfo?: { status: 'completed' | 'failed'; cost: number; duration: number; error?: string };
  model: string;
  permissionMode: string;
  t: TFunction;
  onSend: (prompt: string, opts: { model: string; mode: string }) => void;
  onPermissionApprove: () => void;
  onPermissionAlwaysAllow: () => void;
  onPermissionDeny: () => void;
}

export function MessageStreamStatusTail({
  status,
  waitingReason,
  pendingPermission,
  isRunning,
  isExternal,
  compact,
  prefersReducedMotion,
  resultInfo,
  model,
  permissionMode,
  t,
  onSend,
  onPermissionApprove,
  onPermissionAlwaysAllow,
  onPermissionDeny,
}: MessageStreamStatusTailProps) {
  const fadeUp = prefersReducedMotion ? false : { opacity: 0, y: 6 };
  const sendContinue = () => onSend('Continue', { model, mode: permissionMode });
  const sendWithMode = (text: string) => onSend(text, { model, mode: permissionMode });

  return (
    <>
      {isRunning && !isExternal && (
        <m.div
          initial={prefersReducedMotion ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, ease: 'easeOut' }}
          className="text-muted-foreground flex items-center gap-2.5 py-1 text-sm"
        >
          <D4CAnimation size={compact ? 'sm' : undefined} />
          <span className="text-xs">{t('thread.agentWorking')}</span>
        </m.div>
      )}

      {isRunning && isExternal && (
        <m.div
          initial={prefersReducedMotion ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, ease: 'easeOut' }}
          className="text-muted-foreground flex items-center gap-2.5 py-1 text-sm"
        >
          <div className="flex items-center gap-1">
            <span className="bg-muted-foreground/60 inline-block size-1.5 animate-[thinking_1.4s_ease-in-out_infinite] rounded-full" />
            <span className="bg-muted-foreground/60 inline-block size-1.5 animate-[thinking_1.4s_ease-in-out_0.2s_infinite] rounded-full" />
            <span className="bg-muted-foreground/60 inline-block size-1.5 animate-[thinking_1.4s_ease-in-out_0.4s_infinite] rounded-full" />
          </div>
          <span className="text-xs">{t('thread.runningExternally', 'Running externally...')}</span>
        </m.div>
      )}

      {status === 'waiting' && waitingReason === 'question' && (
        <m.div
          initial={fadeUp}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, ease: 'easeOut' }}
          className="text-status-warning/80 flex items-center gap-2 text-xs"
        >
          <Clock className="size-3.5 animate-pulse text-yellow-400" />
          {t('thread.waitingForResponse')}
        </m.div>
      )}

      {status === 'waiting' && waitingReason === 'permission' && pendingPermission && (
        <m.div
          initial={fadeUp}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, ease: 'easeOut' }}
        >
          <PermissionApprovalCard
            toolName={pendingPermission.toolName}
            toolInput={pendingPermission.toolInput}
            onApprove={onPermissionApprove}
            onAlwaysAllow={onPermissionAlwaysAllow}
            onDeny={onPermissionDeny}
          />
        </m.div>
      )}

      {status === 'waiting' && waitingReason === 'provider_error' && (
        <m.div
          initial={fadeUp}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, ease: 'easeOut' }}
        >
          <ProviderErrorCard onSend={sendWithMode} />
        </m.div>
      )}

      {status === 'waiting' && !waitingReason && (
        <m.div
          initial={fadeUp}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, ease: 'easeOut' }}
        >
          <WaitingActions onSend={sendWithMode} />
        </m.div>
      )}

      {resultInfo && !isRunning && status !== 'stopped' && status !== 'interrupted' && (
        <m.div
          initial={fadeUp}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, ease: 'easeOut' }}
        >
          <AgentResultCard
            status={resultInfo.status}
            cost={resultInfo.cost}
            duration={resultInfo.duration}
            error={resultInfo.error}
            onContinue={resultInfo.status === 'failed' ? sendContinue : undefined}
          />
        </m.div>
      )}

      {status === 'interrupted' && (
        <m.div
          initial={fadeUp}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, ease: 'easeOut' }}
        >
          <AgentInterruptedCard onContinue={sendContinue} />
        </m.div>
      )}

      {status === 'stopped' && (
        <m.div
          initial={fadeUp}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, ease: 'easeOut' }}
        >
          <AgentStoppedCard onContinue={sendContinue} />
        </m.div>
      )}
    </>
  );
}
