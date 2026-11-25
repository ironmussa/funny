import { CircleDot, NotebookPen } from 'lucide-react';
import type { ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';

import { PromptInput } from '../PromptInput';
import { ThreadPreparationView } from './ThreadPreparationView';

type PromptInputProps = ComponentProps<typeof PromptInput>;

/** The "Preparing…" loader shown while a new thread is being created. */
export function NewThreadCreatingView(props: ComponentProps<typeof ThreadPreparationView>) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="new-thread-creating">
      <ThreadPreparationView {...props} />
    </div>
  );
}

/**
 * Scratch variant: no project/repo/branch picker, no worktree preview,
 * no file/symbol references. Just a prompt + model/permission picker.
 */
export function ScratchComposeView({
  onSubmit,
  loading,
  onContentChange,
  initialPrompt,
}: Pick<PromptInputProps, 'onSubmit' | 'loading' | 'onContentChange' | 'initialPrompt'>) {
  const { t } = useTranslation();
  return (
    <div
      className="text-muted-foreground flex flex-1 items-center justify-center px-4"
      data-testid="new-thread-scratch"
    >
      <div className="w-full max-w-3xl">
        <div
          className="text-muted-foreground mb-3 flex h-9 items-center gap-2 text-base"
          data-testid="new-thread-context-bar"
        >
          <span className="flex h-9 shrink-0 items-center gap-1.5 px-2 py-1">
            <NotebookPen className="size-5 shrink-0" data-testid="new-thread-scratch-icon" />
            <span className="truncate font-medium" data-testid="new-thread-scratch-label">
              {t('scratch.composeTitle', { defaultValue: 'New scratch thread' })}
            </span>
          </span>
        </div>
        <div data-testid="new-thread-scratch-prompt">
          <PromptInput
            key="scratch"
            onSubmit={onSubmit}
            loading={loading}
            isNewThread
            isScratch
            onContentChange={onContentChange}
            initialPrompt={initialPrompt}
          />
        </div>
      </div>
    </div>
  );
}

/** Banner shown when the new thread is being created from a GitHub issue. */
export function IssueContextBanner({ title, onDismiss }: { title: string; onDismiss: () => void }) {
  const { t } = useTranslation();
  return (
    <div
      className="border-status-success/20 bg-status-success/5 mb-1.5 flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs"
      data-testid="issue-context-banner"
    >
      <CircleDot className="text-status-success size-3.5 shrink-0" />
      <span className="text-muted-foreground truncate">
        {t('issues.creatingFromIssue', { title })}
      </span>
      <Button
        variant="ghost"
        size="sm"
        className="text-2xs ml-auto h-5 px-1"
        onClick={onDismiss}
        data-testid="issue-context-dismiss"
      >
        {t('common.dismiss')}
      </Button>
    </div>
  );
}
