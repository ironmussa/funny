import type { ThreadStage } from '@funny/shared';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useTooltipMenu } from '@/hooks/use-tooltip-menu';
import { stageConfig } from '@/lib/thread-utils';
import { cn } from '@/lib/utils';
import { useThreadStore } from '@/stores/thread-store';

const VISIBLE_STAGES: ThreadStage[] = ['backlog', 'planning', 'in_progress', 'review', 'done'];

interface Props {
  threadId: string;
  projectId: string;
  stage: ThreadStage;
}

/**
 * Compact stage badge in the thread header that lets the user reassign the
 * thread's lifecycle stage (backlog → done). Extracted from ProjectHeader.tsx
 * so the parent doesn't need the Select cluster or stageConfig.
 */
export const StageSelectorBadge = memo(function StageSelectorBadge({
  threadId,
  projectId,
  stage,
}: Props) {
  const { t } = useTranslation();
  const updateThreadStage = useThreadStore((s) => s.updateThreadStage);
  const StageIcon = stageConfig[stage].icon;
  const { tooltipProps, menuProps, contentProps } = useTooltipMenu();

  return (
    <Select
      value={stage}
      onValueChange={(value: string) =>
        updateThreadStage(threadId, projectId, value as ThreadStage)
      }
      {...menuProps}
    >
      <Tooltip {...tooltipProps}>
        <TooltipTrigger asChild>
          <SelectTrigger
            data-testid="header-stage-select"
            className="border-border/60 hover:bg-accent h-7 w-auto shrink-0 gap-0.5 border bg-transparent px-1.5 py-0 shadow-none [&>svg:last-child]:ml-0"
          >
            <StageIcon className={cn('icon-base', stageConfig[stage].className)} />
          </SelectTrigger>
        </TooltipTrigger>
        <TooltipContent>{t(stageConfig[stage].labelKey)}</TooltipContent>
      </Tooltip>
      <SelectContent {...contentProps}>
        {VISIBLE_STAGES.map((s) => {
          const Icon = stageConfig[s].icon;
          return (
            <SelectItem key={s} value={s}>
              <span className="flex items-center gap-2">
                <Icon className={cn('icon-sm', stageConfig[s].className)} />
                {t(stageConfig[s].labelKey)}
              </span>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
});
