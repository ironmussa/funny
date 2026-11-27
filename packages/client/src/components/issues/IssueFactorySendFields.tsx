/**
 * The body of the "Send to the issue factory" dialog: the flow and lane rows,
 * the branches of the send, what it will do, and the notices under them.
 */
import { MAX_ISSUES_PER_SEND } from '@funny/shared/contracts/factory';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import type { FactorySettings } from '@/lib/api/factory';

import { KEEP_LANE, NEW_LANE, sendBranchesOf, summaryLaneOf } from './issue-factory-send';
import { FieldHint, FieldRow, IssuesFactoryRoute, SendSummary } from './IssueFactorySendRoute';
import type { FactorySendForm, SendLane, SendNotices } from './use-issue-factory-send';

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

/** What the lane select's trigger reads for its value. */
function laneChoiceText(t: TFunction, choice: string): string {
  if (choice === KEEP_LANE) return t('factory.laneNone', 'No lane');
  return choice === NEW_LANE ? t('factory.laneNew', 'New lane…') : choice;
}

/** The send dialog's lane choice: none, an active lane, or a new one to name. */
function LaneField({ lane }: { lane: SendLane }) {
  const { t } = useTranslation();
  return (
    <FieldRow label={t('factory.lane', 'Lane')}>
      <Select value={lane.choice} onValueChange={lane.setChoice}>
        <SelectTrigger
          size="xs"
          className="w-auto shrink-0"
          aria-label={t('factory.lane', 'Lane')}
          data-testid="issues-factory-lane"
        >
          <span className="truncate">{laneChoiceText(t, lane.choice)}</span>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={KEEP_LANE} textSize="xs" data-testid="issues-factory-lane-keep">
            {t('factory.laneNone', 'No lane')}
          </SelectItem>
          {lane.activeLanes.map((active) => (
            <SelectItem
              key={active.id}
              value={active.name}
              textSize="xs"
              data-testid={`issues-factory-lane-${active.name}`}
            >
              {active.name}
            </SelectItem>
          ))}
          <SelectItem value={NEW_LANE} textSize="xs" data-testid="issues-factory-lane-new">
            {t('factory.laneNew', 'New lane…')}
          </SelectItem>
        </SelectContent>
      </Select>
      {lane.choice === NEW_LANE && (
        <Input
          value={lane.newLane}
          onChange={(event) => lane.setNewLane(event.target.value)}
          placeholder={t('factory.laneNamePlaceholder', 'lane name')}
          aria-label={t('factory.laneName', 'Lane name')}
          size="xs"
          autoFocus
          data-testid="issues-factory-lane-name"
        />
      )}
    </FieldRow>
  );
}

/** Under the lane row: a name that cannot name a lane, issues already in another lane. */
function LaneHints({ lane }: { lane: SendLane }) {
  const { t } = useTranslation();
  const nameRefused = lane.invalid && lane.newLane.trim() !== '';
  return (
    <>
      {nameRefused ? (
        <FieldHint testId="issues-factory-lane-invalid">
          <span className="text-status-warning">
            {t(
              'factory.laneNameInvalid',
              'Letters, digits, ".", "_" and "-" only, up to 40 characters.',
            )}
          </span>
        </FieldHint>
      ) : null}
      {lane.otherLane.length > 0 && (
        <FieldHint testId="issues-factory-lane-conflict">
          <span className="text-status-warning">
            {t(
              'factory.laneConflict',
              'Already in another lane: {{issues}}. With two lane labels an issue waits until one is removed.',
              { issues: lane.otherLane.map((o) => `#${o.issue} (${o.label})`).join(', ') },
            )}
          </span>
        </FieldHint>
      )}
    </>
  );
}

/** What the send will do, with the lane and branches chosen above. */
function SendRouteSummary({
  settings,
  form,
}: {
  settings: FactorySettings;
  form: FactorySendForm;
}) {
  const { t } = useTranslation();
  const { lane, route, defaultBranch } = form;
  // The branches as names to read: an existing lane's own, else the ones chosen here.
  const branches = sendBranchesOf(lane.existing, settings, route, defaultBranch);
  const baseName =
    branches.base ||
    defaultBranch ||
    t('factory.routeRepoDefaultBranch', "the repository's default branch");
  return (
    <SendSummary
      lane={summaryLaneOf(lane, settings.laneBranchPrefix)}
      base={baseName}
      baseIsBranch={branches.baseIsBranch}
      finish={branches.finish || baseName}
      finishIsBranch={branches.finishIsBranch}
      lanePrefix={settings.laneLabelPrefix}
      fixed={lane.existing !== null}
    />
  );
}

/** Why the send is off, the size limit, and the blockers the selection waits on. */
function SendNoticeLines({ notices, count }: { notices: SendNotices; count: number }) {
  const { t } = useTranslation();
  const { blocked, outside } = notices;
  return (
    <>
      {blocked && (
        <p className="text-status-warning" data-testid="issues-factory-disabled-reason">
          {blocked}
        </p>
      )}
      {count >= MAX_ISSUES_PER_SEND && (
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
    </>
  );
}

export function IssueFactorySendFields({
  projectId,
  settings,
  form,
  notices,
  count,
}: {
  projectId: string;
  settings: FactorySettings;
  form: FactorySendForm;
  notices: SendNotices;
  /** How many issues the send takes. */
  count: number;
}) {
  const { lane } = form;
  return (
    <div className="flex flex-col gap-3 text-xs" data-testid="issues-factory-bar">
      <FlowField flow={form.flow} options={form.flowOptions} onFlow={form.setFlow} />
      <LaneField lane={lane} />
      <LaneHints lane={lane} />
      <IssuesFactoryRoute
        projectId={projectId}
        settings={settings}
        lane={lane.existing}
        inLane={lane.label !== null && lane.name !== null}
        choice={form.route}
        onChoice={form.setRoute}
        defaultBranch={form.defaultBranch}
      />
      {!lane.invalid && <SendRouteSummary settings={settings} form={form} />}
      <SendNoticeLines notices={notices} count={count} />
    </div>
  );
}
