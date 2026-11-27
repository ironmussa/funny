/**
 * The issue factory in the Issues tab (change factory-manual-queue): each
 * issue's factory state, the checkbox that selects it, and the part of the
 * popup the selection bar opens to send the selection with one flow. Only a caller who may
 * start threads on the project selects issues; only one with a factory sends.
 */
import { implementingThreadOf } from '@funny/shared/contracts/factory';
import type { TFunction } from 'i18next';
import { Factory, RotateCw, Send, X } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogCancelButton,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { LabelBadge, type LabelBadgeTone } from '@/components/ui/label-badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  controlFactoryRun,
  retryFactorySettings,
  sendIssuesToFactory,
} from '@/data/factory/actions';
import { useFactoryRuns, useFactorySettings, useFactorySettingsFailed } from '@/data/factory/hooks';
import { useCanSteerProject } from '@/data/projects/hooks';
import type { FactoryRun, FactorySettings } from '@/lib/api/factory';
import {
  ENDED_FACTORY_STATES,
  factoryRunStateLabel,
  factoryWaitReasonText,
} from '@/lib/factory-run-labels';
import { getThreadRoute } from '@/lib/thread-variant';
import { toastError } from '@/lib/toast-error';
import { cn } from '@/lib/utils';

import { reportSend } from './issue-factory-send';
import { IssueFactorySendFields } from './IssueFactorySendFields';
import {
  useFactorySendForm,
  useSendNotices,
  type FactorySendInput,
} from './use-issue-factory-send';

export { issuesInOtherLane, laneNameFrom } from './issue-factory-send';

export interface IssueFactory {
  /** The caller may steer the project: select issues, delete them. */
  canSteer: boolean;
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
    for (const run of runs ?? []) {
      // A run without an issue (a schedule, "Run a flow") belongs to no row here.
      if (run.issueNumber === null || latestRun.has(run.issueNumber)) continue;
      latestRun.set(run.issueNumber, run);
    }
    const queuePosition = new Map(
      (runs ?? [])
        .filter((run) => run.state === 'requested')
        .sort((a, b) => (a.queueOrder ?? 0) - (b.queueOrder ?? 0))
        // It still holds its place in line, so the positions count it.
        .flatMap((run, index) =>
          run.issueNumber === null ? [] : [[run.issueNumber, index + 1] as const],
        ),
    );
    return {
      canSteer,
      active: canSteer && settings !== null,
      settings,
      unavailable: canSteer && settingsFailed,
      latestRun,
      queuePosition,
    };
  }, [canSteer, settings, settingsFailed, runs]);
}

/** Whether the issue has a run in the factory that has not ended. */
function inFactory(factory: IssueFactory, issueNumber: number): boolean {
  const run = factory.latestRun.get(issueNumber);
  return run !== undefined && !ENDED_FACTORY_STATES.has(run.state);
}

/**
 * Whether an issue can be selected (to send or delete it): the caller may
 * steer the project, and the issue is not in the factory right now.
 */
export function canSelectIssue(factory: IssueFactory, issue: { number: number }) {
  return factory.canSteer && !inFactory(factory, issue.number);
}

/** Whether a selected issue can go to the factory: open, and not already in it. */
export function canSendIssue(factory: IssueFactory, issue: { number: number; state: string }) {
  return factory.active && issue.state === 'open' && !inFactory(factory, issue.number);
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
          aria-label={t('issues.selectIssue', 'Select #{{number}}', {
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
  // Ended well either way: merged, or the agent found nothing to change.
  if (state === 'merged' || state === 'no_change') return 'success';
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
  const lastThread = implementingThreadOf(run);
  const badge = (
    <LabelBadge
      tone={factoryRunTone(run.state)}
      data-testid={`issue-factory-status-${run.issueNumber}`}
    >
      <Factory className="size-2.5 shrink-0" aria-hidden />
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
          variant="outline-muted"
          size="xs"
          className="ml-1"
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

/**
 * The popup the selection bar's "Send to factory" opens: the issues that will
 * go, the flow to run them with, why the send is off and what the selection
 * waits on. It closes once the factory accepted the send.
 */
export function IssuesFactorySendDialog(props: FactorySendInput) {
  const { open, onOpenChange, projectId, settings, selected } = props;
  const { t } = useTranslation();
  const form = useFactorySendForm(props);
  const notices = useSendNotices(projectId, settings, selected);
  const sendOff = notices.blocked !== null || form.sending || form.lane.invalid;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="issues-factory-dialog">
        <DialogHeader>
          <DialogTitle>{t('factory.sendTitle', 'Send to the issue factory')}</DialogTitle>
          <DialogDescription>
            {t('factory.sendDesc', '{{count}} issue(s): {{issues}}', {
              count: selected.length,
              issues: selected.map((n) => `#${n}`).join(', '),
            })}
          </DialogDescription>
        </DialogHeader>
        <IssueFactorySendFields
          projectId={projectId}
          settings={settings}
          form={form}
          notices={notices}
          count={selected.length}
        />
        <DialogFooter>
          <DialogCancelButton data-testid="issues-factory-cancel">
            {t('common.cancel', 'Cancel')}
          </DialogCancelButton>
          <Button onClick={form.send} disabled={sendOff} data-testid="issues-factory-send">
            <Send className="icon-sm" />
            {t('factory.send', 'Send to factory')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
