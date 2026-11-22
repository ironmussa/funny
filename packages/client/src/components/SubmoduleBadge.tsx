import type { NestedDirtyStats } from '@funny/shared';
import { useTranslation } from 'react-i18next';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * "submodule" badge for a gitlink row in a file tree, with a tooltip that
 * summarizes what changed inside the nested repository. Shared by `FileTree`
 * and the review pane's Changes list.
 */
export function SubmoduleBadge({
  nested,
  testId,
  showExpandHint,
}: {
  nested: NestedDirtyStats | undefined;
  testId: string;
  /** Show the "click the arrow to expand" hint (only when rows can expand). */
  showExpandHint: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="border-status-violet/40 bg-status-violet/10 text-status-violet text-2xs shrink-0 rounded-sm border px-1 tracking-wide uppercase"
          data-testid={testId}
        >
          {nested && nested.dirtyFileCount > 0
            ? t('review.submoduleDirtyCount', {
                count: nested.dirtyFileCount,
                defaultValue: 'submodule · {{count}}',
              })
            : t('review.submodule', { defaultValue: 'submodule' })}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs text-xs">
        <div className="font-medium">
          {t('review.submoduleTooltip', {
            defaultValue: 'Nested git repository (gitlink)',
          })}
        </div>
        {nested && <SubmoduleDirtyDetails nested={nested} />}
        {showExpandHint && (
          <div className="text-muted-foreground mt-1">
            {t('review.submoduleExpandHint', {
              defaultValue: 'Click the arrow to expand inner files.',
            })}
          </div>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

function SubmoduleDirtyDetails({ nested }: { nested: NestedDirtyStats }) {
  const { t } = useTranslation();
  const hasLineChanges = nested.linesAdded > 0 || nested.linesDeleted > 0;
  return (
    <div className="mt-1 space-y-0.5 font-mono">
      {nested.pointerMoved && (
        <div>
          {t('review.submodulePointerMoved', {
            defaultValue: 'Gitlink pointer moved (parent-visible change).',
          })}
        </div>
      )}
      <div>
        {t('review.submoduleDirtyLine', {
          count: nested.dirtyFileCount,
          defaultValue: '{{count}} file(s) dirty inside',
        })}
      </div>
      {hasLineChanges && (
        <div>
          <span className="text-diff-added">+{nested.linesAdded}</span>{' '}
          <span className="text-diff-removed">-{nested.linesDeleted}</span>{' '}
          <span className="text-muted-foreground">
            {t('review.submoduleLines', { defaultValue: 'lines' })}
          </span>
        </div>
      )}
    </div>
  );
}
