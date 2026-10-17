import type { GitStatusInfo, Thread } from '@funny/shared';

import { ModeSelect } from '@/components/PromptSelectors';
import { ContextUsageRing } from '@/components/thread/ContextUsageRing';
import { ThreadPowerline } from '@/components/ThreadPowerline';

const RUNTIME_MODES = [
  { value: 'local', label: 'Local' },
  { value: 'remote', label: 'Remote' },
];

export interface PromptFooterBarProps {
  isNewThread: boolean;
  hasLauncher: boolean;
  runtime: 'local' | 'remote';
  onRuntimeChange: (v: string) => void;
  powerlineThread?: Thread;
  powerlineProjectName?: string;
  powerlineProjectColor?: string;
  powerlineProjectPath?: string;
  powerlineGitStatus?: GitStatusInfo;
  onOpenReview?: () => void;
  contextPct?: number;
  contextUsedTokens?: number;
  contextMaxTokens?: number;
  /** When set, the context ring offers compaction (confirmed via {@link onRequestCompact}). */
  onCompact?: () => void;
  onRequestCompact: () => void;
}

type FooterLeadingProps = Pick<
  PromptFooterBarProps,
  | 'isNewThread'
  | 'hasLauncher'
  | 'runtime'
  | 'onRuntimeChange'
  | 'powerlineThread'
  | 'powerlineProjectName'
  | 'powerlineProjectColor'
  | 'powerlineProjectPath'
  | 'powerlineGitStatus'
  | 'onOpenReview'
>;

function FooterLeading(props: FooterLeadingProps) {
  if (props.isNewThread) {
    return (
      <div className="no-scrollbar flex items-center gap-1 overflow-x-auto">
        {props.hasLauncher && (
          <ModeSelect
            value={props.runtime}
            onChange={props.onRuntimeChange}
            modes={RUNTIME_MODES}
          />
        )}
      </div>
    );
  }
  // min-h matches the compact powerline row height so the row stays
  // vertically centered whether or not the diff-stats chip is present.
  return (
    <div className="no-scrollbar flex min-h-[15px] items-center gap-2 overflow-x-auto">
      {props.powerlineThread && (
        <ThreadPowerline
          thread={props.powerlineThread}
          projectName={props.powerlineProjectName}
          projectColor={props.powerlineProjectColor}
          projectTooltip={props.powerlineProjectPath}
          gitStatus={props.powerlineGitStatus}
          diffStatsSize="xs"
          prBadgeTestId="prompt-powerline-pr"
          copyable
          onDiffStatsClick={props.onOpenReview}
          data-testid="prompt-powerline"
        />
      )}
    </div>
  );
}

/**
 * Bottom bar — powerline / new-thread controls + context usage. Sits visually
 * OUTSIDE the bordered prompt box. Skipped entirely when it would be empty
 * (e.g. a new thread with no launcher / context ring), so the box stays tight
 * against whatever follows (MCP list).
 */
export function PromptFooterBar(props: PromptFooterBarProps) {
  const { contextPct, isNewThread } = props;
  const hasContext = typeof contextPct === 'number';
  const hasLeading = isNewThread ? props.hasLauncher : !!props.powerlineThread;
  if (!hasContext && !hasLeading) return null;

  return (
    <div className="mt-1.5 flex items-center gap-2 px-2">
      <div className="min-w-0 flex-1">
        <FooterLeading {...props} />
      </div>
      {hasContext && (
        <div className="shrink-0">
          <ContextUsageRing
            pct={contextPct}
            usedTokens={props.contextUsedTokens}
            maxTokens={props.contextMaxTokens}
            onCompact={props.onCompact ? props.onRequestCompact : undefined}
            disabled={!props.onCompact}
          />
        </div>
      )}
    </div>
  );
}
