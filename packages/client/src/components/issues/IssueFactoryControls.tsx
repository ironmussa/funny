/**
 * The issue factory in the Issues tab (change factory-manual-queue): each
 * issue's factory state, the checkbox that selects it for a send, and the bar
 * that sends the selection with one flow. Only a caller who may start threads
 * on the project and has set up a factory sees any of it.
 */
import { MAX_ISSUES_PER_SEND } from '@funny/shared/contracts/factory';
import type { TFunction } from 'i18next';
import { RotateCw, Send, X } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { LabelBadge, type LabelBadgeTone } from '@/components/ui/label-badge';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  controlFactoryRun,
  retryFactorySettings,
  sendIssuesToFactory,
} from '@/data/factory/actions';
import {
  useFactoryBlockers,
  useFactoryFlows,
  useFactoryRuns,
  useFactorySettings,
  useFactorySettingsFailed,
} from '@/data/factory/hooks';
import { useCanSteerProject } from '@/data/projects/hooks';
import type { FactoryRun, FactorySettings, FactorySubmitResult } from '@/lib/api/factory';
import {
  ENDED_FACTORY_STATES,
  factoryRunStateLabel,
  factoryWaitReasonText,
} from '@/lib/factory-run-labels';
import { getThreadRoute } from '@/lib/thread-variant';
import { toastError } from '@/lib/toast-error';
import { cn } from '@/lib/utils';

export interface IssueFactory {
  /** The caller may send issues (steer + a configured factory). */
  active: boolean;
  settings: FactorySettings | null;
  /**
   * Reading the settings failed: the factory may exist, but its checkboxes
   * stay off until a retry reads it (not the same as "no factory").
   */
  unavailable: boolean;
  /** The latest run of each issue in the caller's factory. */
  latestRun: ReadonlyMap<number, FactoryRun>;
  /** 1-based position of each waiting issue in the queue. */
  queuePosition: ReadonlyMap<number, number>;
}

/** What the Issues tab knows about the caller's factory for the project. */
export function useIssueFactory(projectId: string): IssueFactory {
  const canSteer = useCanSteerProject(projectId);
  const settings = useFactorySettings(projectId) ?? null;
  const settingsFailed = useFactorySettingsFailed(projectId);
  const runs = useFactoryRuns(projectId);
  return useMemo(() => {
    const latestRun = new Map<number, FactoryRun>();
    // Runs come newest first: the first one seen for an issue is its latest.
    for (const run of runs ?? [])
      if (!latestRun.has(run.issueNumber)) latestRun.set(run.issueNumber, run);
    const queuePosition = new Map(
      (runs ?? [])
        .filter((run) => run.state === 'requested')
        .sort((a, b) => (a.queueOrder ?? 0) - (b.queueOrder ?? 0))
        .map((run, index) => [run.issueNumber, index + 1] as const),
    );
    return {
      active: canSteer && settings !== null,
      settings,
      unavailable: canSteer && settingsFailed,
      latestRun,
      queuePosition,
    };
  }, [canSteer, settings, settingsFailed, runs]);
}

/** Whether an issue can be selected for a send: open, and not already in the factory. */
export function canSendIssue(factory: IssueFactory, issue: { number: number; state: string }) {
  if (!factory.active || issue.state !== 'open') return false;
  const run = factory.latestRun.get(issue.number);
  return !run || ENDED_FACTORY_STATES.has(run.state);
}

/**
 * The issue's state icon, which turns into its selection checkbox: the icon
 * shows by default (also while other issues are selected), the checkbox on
 * hover or keyboard focus, and the checkbox stays while this issue is selected.
 */
export function IssueSelectToggle({
  issueNumber,
  icon,
  checked,
  onToggle,
}: {
  issueNumber: number;
  icon: ReactNode;
  checked: boolean;
  onToggle: (issueNumber: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <span
      className="group/select icon-base relative mt-0.5 shrink-0"
      data-testid={`issue-select-toggle-${issueNumber}`}
    >
      <span
        aria-hidden
        className={cn(
          'absolute inset-0 grid place-items-center transition-opacity',
          checked
            ? 'opacity-0'
            : 'group-focus-within/select:opacity-0 group-hover/select:opacity-0',
        )}
      >
        {icon}
      </span>
      <span
        className={cn(
          'absolute inset-0 grid place-items-center transition-opacity',
          checked
            ? 'opacity-100'
            : 'opacity-0 group-focus-within/select:opacity-100 group-hover/select:opacity-100',
        )}
      >
        <Checkbox
          checked={checked}
          onCheckedChange={() => onToggle(issueNumber)}
          aria-label={t('factory.selectIssue', 'Select #{{number}} for the factory', {
            number: issueNumber,
          })}
          data-testid={`issue-select-${issueNumber}`}
        />
      </span>
    </span>
  );
}

function statusText(t: TFunction, run: FactoryRun, position: number | undefined): string {
  const label = factoryRunStateLabel(t, run.state);
  return run.state === 'requested' && position
    ? t('factory.queuePosition', '{{label}} · #{{position}}', { label, position })
    : label;
}

/** The pastel of a run's state chip, next to the issue's GitHub labels. */
function factoryRunTone(state: FactoryRun['state']): LabelBadgeTone {
  if (state === 'merged') return 'success';
  if (state === 'failed') return 'danger';
  if (state === 'waiting_human') return 'warning';
  if (state === 'stopped') return 'neutral';
  return 'info';
}

/** An issue's state in the caller's factory; opens the run's last thread. */
export function IssueFactoryStatus({
  projectId,
  run,
  position,
}: {
  projectId: string;
  run: FactoryRun;
  position: number | undefined;
}) {
  const { t } = useTranslation();
  const lastThread = run.threadIds.at(-1);
  const badge = (
    <LabelBadge
      tone={factoryRunTone(run.state)}
      data-testid={`issue-factory-status-${run.issueNumber}`}
    >
      {statusText(t, run, position)}
    </LabelBadge>
  );
  const cancel = () =>
    void controlFactoryRun('stop', projectId, run.id).orTee((error) =>
      toastError(error, 'factory'),
    );
  // A blocker that is not in the factory can be sent from here, with this issue's flow.
  const unsent = run.state === 'requested' && run.waitReason?.kind === 'blocker-not-sent';
  const sendBlockers = () =>
    void sendIssuesToFactory(projectId, run.waitReason!.blockers, run.flowName ?? '').match(
      (result) => reportSend(t, result),
      (error) => toastError(error, 'factory'),
    );

  return (
    <span className="flex items-center gap-0.5">
      <Tooltip>
        <TooltipTrigger asChild>
          {lastThread ? (
            <Link
              to={getThreadRoute({ id: lastThread, projectId, isScratch: false })}
              data-testid={`issue-factory-thread-${run.issueNumber}`}
            >
              {badge}
            </Link>
          ) : (
            badge
          )}
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {run.state === 'requested' && run.waitReason
            ? factoryWaitReasonText(t, run.waitReason)
            : t('factory.issueInFactory', 'In your issue factory')}
        </TooltipContent>
      </Tooltip>
      {unsent && run.flowName && (
        <Button
          variant="link"
          size="xs"
          onClick={sendBlockers}
          data-testid={`issue-factory-send-blockers-${run.issueNumber}`}
        >
          {t('factory.sendBlockers', 'Send {{blockers}}', {
            blockers: run.waitReason!.blockers.map((n) => `#${n}`).join(', '),
          })}
        </Button>
      )}
      {run.state === 'requested' && (
        <Button
          variant="outline"
          size="xs"
          className="text-muted-foreground hover:text-foreground ml-1"
          onClick={cancel}
          data-testid={`issue-factory-cancel-${run.issueNumber}`}
        >
          <X className="icon-xs" />
          {t('factory.cancelQueued', 'Remove from the queue')}
        </Button>
      )}
    </span>
  );
}

/**
 * Shown instead of the checkboxes when the factory settings could not be read:
 * says why they are missing, and reads them again on demand (they are also
 * retried on their own while shown).
 */
export function IssuesFactoryUnavailable({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const [retrying, setRetrying] = useState(false);
  const retry = () => {
    setRetrying(true);
    void retryFactorySettings(projectId).finally(() => setRetrying(false));
  };
  return (
    <div
      className="border-sidebar-border bg-sidebar text-muted-foreground flex items-center gap-1.5 border-b px-2 py-1 text-xs"
      data-testid="issues-factory-unavailable"
    >
      <span className="min-w-0 flex-1">
        {t(
          'factory.settingsUnavailable',
          "Couldn't load your issue factory, so issues can't be selected for it yet.",
        )}
      </span>
      <Button
        variant="ghost"
        size="xs"
        onClick={retry}
        disabled={retrying}
        data-testid="issues-factory-retry"
      >
        <RotateCw className={cn('icon-xs', retrying && 'animate-spin')} />
        {t('common.retry', 'Retry')}
      </Button>
    </div>
  );
}

/** Why the send button is off, or null. */
function sendBlockedReason(t: TFunction, settings: FactorySettings): string | null {
  if (!settings.enabled) {
    return t('factory.pausedSend', 'The factory is paused. Resume it in the project settings.');
  }
  return settings.blockedReason;
}

function reportSend(t: TFunction, result: FactorySubmitResult): void {
  if (result.accepted.length > 0) {
    toast.success(
      t('factory.sent', 'Sent {{count}} issue(s) to the factory', {
        count: result.accepted.length,
      }),
    );
  }
  if (result.refused.length > 0) {
    toast.warning(result.refused.map((refusal) => refusal.message).join(' '));
  }
}

/** The bar shown above the issues while some are selected: pick a flow and send them. */
export function IssuesFactoryBar({
  projectId,
  settings,
  selected,
  onSent,
  onClear,
}: {
  projectId: string;
  settings: FactorySettings;
  selected: number[];
  /** The issues the factory accepted (they leave the selection). */
  onSent: (accepted: number[]) => void;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  const flows = useFactoryFlows(projectId);
  const [flow, setFlow] = useState(settings.flowName);
  const [sending, setSending] = useState(false);
  const blockers = useFactoryBlockers(projectId, selected);
  const blocked = sendBlockedReason(t, settings);

  const outside = [
    ...new Set(
      (blockers ?? []).flatMap((entry) =>
        entry.blockers
          .filter((b) => !b.inFactory && !selected.includes(b.issue))
          .map((b) => b.issue),
      ),
    ),
  ];
  const options = flows ?? [{ name: settings.flowName, source: 'built-in' as const }];

  const send = () => {
    setSending(true);
    void sendIssuesToFactory(projectId, selected, flow).match(
      (result) => {
        setSending(false);
        reportSend(t, result);
        onSent(result.accepted);
      },
      (error) => {
        setSending(false);
        toastError(error, 'factory');
      },
    );
  };

  return (
    <div
      className="border-sidebar-border bg-sidebar flex flex-col gap-1.5 border-b px-2 py-1 text-xs"
      data-testid="issues-factory-bar"
    >
      <div className="flex items-center gap-1.5">
        <span className="text-muted-foreground">
          {t('factory.selectedCount', '{{count}} selected', { count: selected.length })}
        </span>
        <Button
          variant="ghost"
          size="xs"
          onClick={onClear}
          className="text-muted-foreground"
          data-testid="issues-factory-clear-selection"
        >
          {t('common.clear', 'Clear')}
        </Button>
        <div className="min-w-0 flex-1" />
        <Select value={flow} onValueChange={setFlow}>
          <SelectTrigger size="xs" className="w-auto gap-1" data-testid="issues-factory-flow">
            <span className="truncate">{flow}</span>
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem
                key={option.name}
                value={option.name}
                className="text-xs"
                data-testid={`issues-factory-flow-${option.name}`}
              >
                {option.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="xs"
          onClick={send}
          disabled={blocked !== null || sending}
          data-testid="issues-factory-send"
        >
          <Send className="icon-xs" />
          {t('factory.send', 'Send to factory')}
        </Button>
      </div>
      {blocked && (
        <p className="text-status-warning" data-testid="issues-factory-disabled-reason">
          {blocked}
        </p>
      )}
      {selected.length >= MAX_ISSUES_PER_SEND && (
        <p className="text-muted-foreground" data-testid="issues-factory-limit">
          {t('factory.sendLimit', 'Up to {{max}} issues per send', { max: MAX_ISSUES_PER_SEND })}
        </p>
      )}
      {!blocked && outside.length > 0 && (
        <p className="text-muted-foreground" data-testid="issues-factory-warning">
          {t(
            'factory.blockerWarning',
            'Depends on {{blockers}}, which is not in the factory: those issues will wait for it.',
            { blockers: outside.map((n) => `#${n}`).join(', ') },
          )}
        </p>
      )}
    </div>
  );
}
