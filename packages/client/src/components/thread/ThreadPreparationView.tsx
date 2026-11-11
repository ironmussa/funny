import { CircleX } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { D4CAnimation } from '@/components/D4CAnimation';
import type { GitProgressStep } from '@/components/GitProgressModal';
import { PromptInput } from '@/components/PromptInput';
import type { SubmitFn } from '@/hooks/prompt-input-types';
import { cn } from '@/lib/utils';

import { UserMessageCard, type UserMessageCardProps } from './UserMessageCard';

export type PreparationMessageMetadata = Pick<
  UserMessageCardProps,
  'model' | 'permissionMode' | 'effort' | 'timestamp'
>;

const ignoreSubmit = async () => false;
const NO_STEPS: GitProgressStep[] = [];

/**
 * Conversation placeholder while the server creates the thread or prepares its
 * worktree. Mirrors `MessageStreamShell`'s DOM (scroll viewport, content stack,
 * user message row, status tail, sticky prompt dock) so the swap to the real
 * conversation keeps every element in place.
 */
export function ThreadPreparationView({
  prompt,
  projectId,
  metadata,
  steps = NO_STEPS,
  onRetry,
  retrying = false,
}: {
  prompt?: string;
  projectId?: string;
  metadata?: PreparationMessageMetadata;
  steps?: GitProgressStep[];
  /**
   * Set when the preparation failed and can be retried: the prompt dock is
   * enabled and submitting it retries (e.g. a sandbox whose setup failed).
   */
  onRetry?: SubmitFn;
  /** True while the retry request is in flight. */
  retrying?: boolean;
}) {
  const { t } = useTranslation();
  // A failed step wins: it is what the user must see (with its error), not the
  // last step of the list.
  const step =
    steps.find((item) => item.status === 'failed') ??
    steps.find((item) => item.status === 'running') ??
    steps.at(-1);
  const failed = step?.status === 'failed';

  return (
    <div
      className="relative flex min-h-0 min-w-0 flex-1 flex-col"
      data-testid="thread-preparation-view"
    >
      <div
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto"
        style={{ scrollbarGutter: 'stable', overscrollBehaviorY: 'contain' }}
      >
        <div className="mx-auto w-full max-w-3xl min-w-0 space-y-4 px-4 pt-1 pb-4 md:pt-4">
          {prompt && (
            <div className="relative pt-3 pb-3">
              <UserMessageCard content={prompt} {...metadata} />
            </div>
          )}
          <div
            role="status"
            className={cn(
              'text-muted-foreground py-1 text-sm',
              failed && 'border-destructive/40 bg-destructive/5 rounded-md border px-3 py-2',
            )}
            data-testid="thread-preparation-status"
          >
            <div className="flex items-center gap-2.5">
              {failed ? (
                <CircleX
                  className="text-destructive icon-sm shrink-0"
                  data-testid="thread-preparation-failed"
                />
              ) : (
                <D4CAnimation />
              )}
              <span className={cn('text-xs', failed && 'text-destructive font-medium')}>
                {step?.label ?? t('common.preparing', 'Preparing…')}
              </span>
            </div>
            {step?.error && (
              <p className="text-destructive mt-2 text-xs whitespace-pre-wrap">{step.error}</p>
            )}
          </div>
        </div>

        <div className="grow" aria-hidden="true" />

        <fieldset disabled={!onRetry} className="bg-background sticky bottom-0 z-30 min-w-0">
          <PromptInput
            onSubmit={onRetry ?? ignoreSubmit}
            loading={!onRetry || retrying}
            projectId={projectId}
            placeholder={
              onRetry
                ? t('thread.retrySandboxPrompt', 'Write a message to retry the sandbox…')
                : t('thread.nextPrompt')
            }
          />
        </fieldset>
      </div>
    </div>
  );
}
