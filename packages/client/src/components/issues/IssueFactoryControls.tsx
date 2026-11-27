/**
 * The issue factory in the Issues tab (change factory-manual-queue): each
 * issue's factory state, the checkbox that selects it, and the part of the
 * popup the selection bar opens to send the selection with one flow. Only a caller who may
 * start threads on the project selects issues; only one with a factory sends.
 */
import { MAX_ISSUES_PER_SEND, implementingThreadOf } from '@funny/shared/contracts/factory';
import type { DomainError } from '@funny/shared/errors';
import type { TFunction } from 'i18next';
import { Factory, RotateCw, Send, X } from 'lucide-react';
import { okAsync, type ResultAsync } from 'neverthrow';
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
import { Input } from '@/components/ui/input';
import { LabelBadge, type LabelBadgeTone } from '@/components/ui/label-badge';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { toast } from '@/components/ui/toast';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  controlFactoryRun,
  retryFactorySettings,
  sendIssuesToFactory,
} from '@/data/factory/actions';
import {
  useFactoryBlockers,
  useFactoryFlows,
  useFactoryLanes,
  useFactoryRuns,
  useFactorySettings,
  useFactorySettingsFailed,
} from '@/data/factory/hooks';
import { useDataQuery } from '@/data/hooks';
import { projectBranchesQuery } from '@/data/projects/branches';
import { useCanSteerProject } from '@/data/projects/hooks';
import { api } from '@/lib/api';
import type { FactoryRun, FactorySettings, FactorySubmitResult } from '@/lib/api/factory';
import {
  ENDED_FACTORY_STATES,
  factoryRunStateLabel,
  factoryWaitReasonText,
} from '@/lib/factory-run-labels';
import { getThreadRoute } from '@/lib/thread-variant';
import { toastError } from '@/lib/toast-error';
import { cn } from '@/lib/utils';

import {
  FieldHint,
  FieldRow,
  IssuesFactoryRoute,
  SendSummary,
  sendRouteOf,
  type RouteChoice,
} from './IssueFactorySendRoute';

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

/** The lane select's value for "leave the issues' labels as they are". */
const KEEP_LANE = '__keep__';
/** The lane select's value for "a lane that does not exist yet". */
const NEW_LANE = '__new__';

/**
 * A lane's name as it goes after the label prefix: lower-cased, as the
 * factory keeps it, and something a branch name can end with. Null when the
 * text cannot name a lane.
 */
export function laneNameFrom(text: string): string | null {
  const name = text.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{0,39}$/.test(name) && !name.includes('..') ? name : null;
}

/**
 * The selected issues that already carry a lane label other than `label`: with
 * both, the factory sees two lanes and keeps the issue waiting.
 */
export function issuesInOtherLane(
  selected: number[],
  labelsOf: (issueNumber: number) => string[],
  prefix: string,
  label: string,
): Array<{ issue: number; label: string }> {
  const lower = prefix.toLowerCase();
  return selected.flatMap((issue) => {
    const other = labelsOf(issue).find(
      (l) => l.toLowerCase().startsWith(lower) && l.toLowerCase() !== label.toLowerCase(),
    );
    return other ? [{ issue, label: other }] : [];
  });
}

/** The send dialog's flow choice. */
function FlowField({
  flow,
  options,
  onFlow,
}: {
  flow: string;
  options: ReadonlyArray<{ name: string }>;
  onFlow: (flow: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <FieldRow label={t('factory.flow', 'Flow')}>
      <Select value={flow} onValueChange={onFlow}>
        <SelectTrigger
          size="xs"
          className="w-auto"
          aria-label={t('factory.flow', 'Flow')}
          data-testid="issues-factory-flow"
        >
          <span className="truncate">{flow}</span>
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem
              key={option.name}
              value={option.name}
              textSize="xs"
              data-testid={`issues-factory-flow-${option.name}`}
            >
              {option.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FieldRow>
  );
}

/**
 * The popup the selection bar's "Send to factory" opens: the issues that will
 * go, the flow to run them with, why the send is off and what the selection
 * waits on. It closes once the factory accepted the send.
 */
export function IssuesFactorySendDialog({
  open,
  onOpenChange,
  projectId,
  settings,
  selected,
  labelsOf,
  onSent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  settings: FactorySettings;
  /** The selected issues that can be sent. */
  selected: number[];
  /** The GitHub labels an issue of the list carries now. */
  labelsOf: (issueNumber: number) => string[];
  /** The issues the factory accepted (they leave the selection). */
  onSent: (accepted: number[]) => void;
}) {
  const { t } = useTranslation();
  const flows = useFactoryFlows(projectId);
  const lanes = useFactoryLanes(projectId);
  const [laneChoice, setLaneChoice] = useState(KEEP_LANE);
  const [newLane, setNewLane] = useState('');
  const activeLanes = (lanes ?? []).filter((lane) => lane.state === 'active');
  // The lane the send puts the issues in: null keeps their labels as they are.
  const laneName =
    laneChoice === KEEP_LANE ? null : laneChoice === NEW_LANE ? laneNameFrom(newLane) : laneChoice;
  const laneLabel = laneName === null ? null : `${settings.laneLabelPrefix}${laneName}`;
  const laneInvalid = laneChoice === NEW_LANE && laneName === null;
  const otherLane = laneLabel
    ? issuesInOtherLane(selected, labelsOf, settings.laneLabelPrefix, laneLabel)
    : [];
  const [flow, setFlow] = useState(settings.flowName);
  const [sending, setSending] = useState(false);
  // The branches for this send alone; they start as the factory's settings.
  const [route, setRoute] = useState<RouteChoice>({
    base: settings.baseBranch,
    finish: settings.laneFinishBranch,
  });
  const { data: branchData } = useDataQuery(projectBranchesQuery(projectId));
  const existingLane = activeLanes.find((lane) => lane.name === laneChoice) ?? null;
  const defaultBranch = branchData?.defaultBranch ?? undefined;
  // The branches as names to read: an existing lane's own, else the ones chosen here.
  const baseChoice = existingLane ? (existingLane.baseBranch ?? settings.baseBranch) : route.base;
  const baseName =
    baseChoice ||
    defaultBranch ||
    t('factory.routeRepoDefaultBranch', "the repository's default branch");
  const finishChoice = existingLane
    ? (existingLane.finishBranch ?? settings.laneFinishBranch)
    : route.finish;
  const finishName = finishChoice || baseName;
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

  // The lane is a label on the issue (openspec factory-lanes D1), read when the
  // factory admits it: the label goes on first, and an issue GitHub did not
  // label is not sent, so it cannot run outside the lane it was meant for.
  const labelForLane = (): ResultAsync<number[], DomainError> =>
    laneLabel === null
      ? okAsync(selected)
      : api.githubAddIssueLabels(projectId, selected, [laneLabel]).map((result) => {
          if (result.failed.length > 0) {
            toast.warning(
              t(
                'factory.laneLabelFailed',
                'Not sent, the lane label could not be added: {{issues}}',
                {
                  issues: result.failed.map((f) => f.message).join(' '),
                },
              ),
            );
          }
          return result.labeled;
        });

  const send = () => {
    setSending(true);
    void labelForLane()
      .andThen((issues) =>
        sendIssuesToFactory(
          projectId,
          issues,
          flow,
          // A lane that exists keeps its branches: the send names none for it.
          existingLane ? undefined : sendRouteOf(route, settings, laneName, defaultBranch),
        ),
      )
      .match(
        (result) => {
          setSending(false);
          reportSend(t, result);
          if (result.accepted.length > 0) onOpenChange(false);
          onSent(result.accepted);
        },
        (error) => {
          setSending(false);
          toastError(error, 'factory');
        },
      );
  };

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
        <div className="flex flex-col gap-3 text-xs" data-testid="issues-factory-bar">
          <FlowField flow={flow} options={options} onFlow={setFlow} />
          <FieldRow label={t('factory.lane', 'Lane')}>
            <Select value={laneChoice} onValueChange={setLaneChoice}>
              <SelectTrigger
                size="xs"
                className="w-auto shrink-0"
                aria-label={t('factory.lane', 'Lane')}
                data-testid="issues-factory-lane"
              >
                <span className="truncate">
                  {laneChoice === KEEP_LANE
                    ? t('factory.laneNone', 'No lane')
                    : laneChoice === NEW_LANE
                      ? t('factory.laneNew', 'New lane…')
                      : laneChoice}
                </span>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={KEEP_LANE} textSize="xs" data-testid="issues-factory-lane-keep">
                  {t('factory.laneNone', 'No lane')}
                </SelectItem>
                {activeLanes.map((lane) => (
                  <SelectItem
                    key={lane.id}
                    value={lane.name}
                    textSize="xs"
                    data-testid={`issues-factory-lane-${lane.name}`}
                  >
                    {lane.name}
                  </SelectItem>
                ))}
                <SelectItem value={NEW_LANE} textSize="xs" data-testid="issues-factory-lane-new">
                  {t('factory.laneNew', 'New lane…')}
                </SelectItem>
              </SelectContent>
            </Select>
            {laneChoice === NEW_LANE && (
              <Input
                value={newLane}
                onChange={(event) => setNewLane(event.target.value)}
                placeholder={t('factory.laneNamePlaceholder', 'lane name')}
                aria-label={t('factory.laneName', 'Lane name')}
                size="xs"
                autoFocus
                data-testid="issues-factory-lane-name"
              />
            )}
          </FieldRow>
          {laneInvalid && newLane.trim() !== '' ? (
            <FieldHint testId="issues-factory-lane-invalid">
              <span className="text-status-warning">
                {t(
                  'factory.laneNameInvalid',
                  'Letters, digits, ".", "_" and "-" only, up to 40 characters.',
                )}
              </span>
            </FieldHint>
          ) : null}
          {otherLane.length > 0 && (
            <FieldHint testId="issues-factory-lane-conflict">
              <span className="text-status-warning">
                {t(
                  'factory.laneConflict',
                  'Already in another lane: {{issues}}. With two lane labels an issue waits until one is removed.',
                  { issues: otherLane.map((o) => `#${o.issue} (${o.label})`).join(', ') },
                )}
              </span>
            </FieldHint>
          )}
          <IssuesFactoryRoute
            projectId={projectId}
            settings={settings}
            lane={existingLane}
            inLane={laneLabel !== null && laneName !== null}
            choice={route}
            onChoice={setRoute}
            defaultBranch={defaultBranch}
          />
          {!laneInvalid && (
            <SendSummary
              lane={
                laneLabel && laneName
                  ? {
                      label: laneLabel,
                      branch: existingLane?.branch ?? `${settings.laneBranchPrefix}${laneName}`,
                      isNew: existingLane === null,
                    }
                  : null
              }
              base={baseName}
              baseIsBranch={!!(baseChoice || defaultBranch)}
              finish={finishName}
              finishIsBranch={!!(finishChoice || baseChoice || defaultBranch)}
              lanePrefix={settings.laneLabelPrefix}
              fixed={existingLane !== null}
            />
          )}
          {blocked && (
            <p className="text-status-warning" data-testid="issues-factory-disabled-reason">
              {blocked}
            </p>
          )}
          {selected.length >= MAX_ISSUES_PER_SEND && (
            <p className="text-muted-foreground" data-testid="issues-factory-limit">
              {t('factory.sendLimit', 'Up to {{max}} issues per send', {
                max: MAX_ISSUES_PER_SEND,
              })}
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
        <DialogFooter>
          <DialogCancelButton data-testid="issues-factory-cancel">
            {t('common.cancel', 'Cancel')}
          </DialogCancelButton>
          <Button
            onClick={send}
            disabled={blocked !== null || sending || laneInvalid}
            data-testid="issues-factory-send"
          >
            <Send className="icon-sm" />
            {t('factory.send', 'Send to factory')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
