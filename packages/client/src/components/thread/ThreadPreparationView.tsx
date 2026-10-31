import { useTranslation } from 'react-i18next';

import { D4CAnimation } from '@/components/D4CAnimation';
import type { GitProgressStep } from '@/components/GitProgressModal';
import { PromptInput } from '@/components/PromptInput';

import { UserMessageCard, type UserMessageCardProps } from './UserMessageCard';

export type PreparationMessageMetadata = Pick<
  UserMessageCardProps,
  'model' | 'permissionMode' | 'effort' | 'timestamp'
>;

const ignoreSubmit = async () => false;

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
  steps = [],
}: {
  prompt?: string;
  projectId?: string;
  metadata?: PreparationMessageMetadata;
  steps?: GitProgressStep[];
}) {
  const { t } = useTranslation();
  const step = steps.find((item) => item.status === 'running') ?? steps.at(-1);

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
          <div role="status" className="text-muted-foreground py-1 text-sm">
            <div className="flex items-center gap-2.5">
              <D4CAnimation />
              <span className="text-xs">{step?.label ?? t('common.preparing', 'Preparing…')}</span>
            </div>
            {step?.error && (
              <p className="text-destructive mt-2 text-xs whitespace-pre-wrap">{step.error}</p>
            )}
          </div>
        </div>

        <div className="grow" aria-hidden="true" />

        <fieldset disabled className="bg-background sticky bottom-0 z-30 min-w-0">
          <PromptInput
            onSubmit={ignoreSubmit}
            loading
            projectId={projectId}
            placeholder={t('thread.nextPrompt')}
          />
        </fieldset>
      </div>
    </div>
  );
}
