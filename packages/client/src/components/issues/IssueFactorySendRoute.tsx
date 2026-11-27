/**
 * The route part of the "Send to the issue factory" dialog (change
 * factory-lanes, D13): the rows that choose the branches of one send, the
 * route the send asks for, and the summary of what the send will do.
 */
import type { FactoryLane, FactoryRunRoute } from '@funny/shared/contracts/factory';
import { Info } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { BranchBadge } from '@/components/BranchBadge';
import { BranchPicker } from '@/components/SearchablePicker';
import { LabelBadge } from '@/components/ui/label-badge';
import { useDataQuery } from '@/data/hooks';
import { projectBranchesQuery } from '@/data/projects/branches';
import type { FactorySettings } from '@/lib/api/factory';

const REPO_DEFAULT = '__repo_default__';
const NO_BRANCHES: string[] = [];

/** One row of the send dialog: a label in a fixed column, then its control. */
export function FieldRow({
  label,
  children,
  testId,
}: {
  label: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3" data-testid={testId}>
      <span className="text-muted-foreground w-20 shrink-0">{label}</span>
      <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
    </div>
  );
}

/** A muted line under a row, aligned with the controls. */
export function FieldHint({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <p className="text-muted-foreground -mt-1 pl-[calc(5rem+0.75rem)]" data-testid={testId}>
      {children}
    </p>
  );
}

/**
 * A branch chosen in the send dialog for the issues being sent: the branches
 * on origin first, then local ones, plus one "empty" item (the repository
 * default, or "Same as Starts from" for the finish branch).
 */
function RouteBranchPicker({
  projectId,
  value,
  emptyLabel,
  onChange,
  testId,
}: {
  projectId: string;
  value: string;
  emptyLabel: string;
  onChange: (branch: string) => void;
  testId: string;
}) {
  const { data } = useDataQuery(projectBranchesQuery(projectId));
  const remote = data?.remoteBranches ?? NO_BRANCHES;
  const branches = [...new Set([...remote, ...(data?.branches ?? NO_BRANCHES)])];
  return (
    <BranchPicker
      branches={branches}
      remoteBranches={remote}
      defaultBranch={data?.defaultBranch}
      selected={value}
      onChange={(branch) => {
        const next = branch === REPO_DEFAULT ? '' : branch;
        if (next !== value) onChange(next);
      }}
      extraItems={[{ key: REPO_DEFAULT, label: emptyLabel, isSelected: !value }]}
      placeholder={emptyLabel}
      triggerClassName="flex h-6 min-w-0 max-w-[220px] items-center justify-between gap-2 rounded-md border border-input bg-background px-2 text-xs hover:bg-accent/50"
      side="bottom"
      align="start"
      width="w-72"
      compact
      showCopy={false}
      testId={testId}
    />
  );
}

/** The branches the dialog shows: '' is the repository default / "same as Starts from". */
export interface RouteChoice {
  base: string;
  finish: string;
}

/**
 * The route the send asks for (change factory-lanes, D13): only what differs
 * from the factory's settings, as real branch names, so an untouched dialog
 * sends nothing and the issues follow the settings. `defaultBranch` names the
 * repository default when the dialog chose it; unknown, that choice is left
 * to the factory.
 */
export function sendRouteOf(
  choice: RouteChoice,
  settings: Pick<FactorySettings, 'baseBranch' | 'laneFinishBranch'>,
  newLane: string | null,
  defaultBranch: string | undefined,
): FactoryRunRoute | undefined {
  const base = choice.base || defaultBranch;
  const baseBranch = choice.base !== settings.baseBranch ? base : undefined;
  if (newLane === null) return baseBranch ? { baseBranch } : undefined;
  const finishBranch =
    choice.finish !== settings.laneFinishBranch ? choice.finish || base : undefined;
  return baseBranch || finishBranch
    ? { lane: { name: newLane, baseBranch, finishBranch } }
    : undefined;
}

/** A branch a lane already has: shown, not chosen. */
function FixedBranch({ branch, fallback }: { branch: string; fallback: string }) {
  return branch ? <BranchBadge branch={branch} /> : <span>{fallback}</span>;
}

/**
 * Where the sent issues land (change factory-lanes): without a lane, each
 * pull request merges into "Merge into"; in a lane, into the lane's branch,
 * which starts from "Starts from" and goes to "Finish into" when the lane is
 * finished. The branches chosen here are for the issues being sent: a new
 * lane keeps them, and the factory's settings do not change. A lane that
 * exists shows the branches it was made with.
 */
export function IssuesFactoryRoute({
  projectId,
  settings,
  lane,
  inLane,
  choice,
  onChoice,
  defaultBranch,
}: {
  projectId: string;
  settings: FactorySettings;
  /** The existing lane the issues go to; null for no lane or a new one. */
  lane: FactoryLane | null;
  inLane: boolean;
  choice: RouteChoice;
  onChoice: (choice: RouteChoice) => void;
  /** The repository's default branch, when known: named instead of "Repository default". */
  defaultBranch: string | undefined;
}) {
  const { t } = useTranslation();
  const repoDefault = defaultBranch
    ? t('factory.routeRepoDefaultNamed', '{{branch}} (repository default)', {
        branch: defaultBranch,
      })
    : t('settings.projectFactoryBaseBranchDefault', 'Repository default');
  const sameAsStart = t('factory.routeSameAsStart', 'Same as Starts from');
  const laneBase = lane ? (lane.baseBranch ?? settings.baseBranch) : '';
  return (
    <>
      <FieldRow
        label={
          inLane
            ? t('factory.routeStartsFrom', 'Starts from')
            : t('settings.projectFactoryBaseBranch', 'Merge into')
        }
        testId="issues-factory-route-base"
      >
        {lane ? (
          <FixedBranch branch={laneBase} fallback={repoDefault} />
        ) : (
          <RouteBranchPicker
            projectId={projectId}
            value={choice.base}
            emptyLabel={repoDefault}
            onChange={(base) => onChoice({ ...choice, base })}
            testId="issues-factory-route-base-picker"
          />
        )}
      </FieldRow>
      {inLane && (
        <FieldRow
          label={t('settings.projectFactoryLaneFinishBranch', 'Finish into')}
          testId="issues-factory-route-finish"
        >
          {lane ? (
            <FixedBranch
              branch={lane.finishBranch ?? (settings.laneFinishBranch || laneBase)}
              fallback={sameAsStart}
            />
          ) : (
            <RouteBranchPicker
              projectId={projectId}
              value={choice.finish}
              emptyLabel={sameAsStart}
              onChange={(finish) => onChoice({ ...choice, finish })}
              testId="issues-factory-route-finish-picker"
            />
          )}
        </FieldRow>
      )}
    </>
  );
}

// Stands for a chip inside a translated sentence: a character no translation contains.
const CHIP_MARK = '\u0000';

/**
 * Translates a sentence whose values are shown as chips (a branch, a label):
 * each value goes into the sentence as a marker, and the markers are then
 * replaced with their chips, so the translations keep their plain `{{name}}`.
 */
function withChips(
  translate: (values: Record<string, string>) => string,
  chips: Record<string, ReactNode>,
): ReactNode {
  const markers = Object.fromEntries(
    Object.keys(chips).map((key) => [key, `${CHIP_MARK}${key}${CHIP_MARK}`]),
  );
  return translate(markers)
    .split(CHIP_MARK)
    .map((part, i) => (
      // Odd parts sit between two markers: they are the names of chips.
      <Fragment key={i}>{i % 2 === 1 ? (chips[part] ?? part) : part}</Fragment>
    ));
}

/** A branch inside a summary sentence, as a chip; a name to read stays text. */
function summaryBranch(name: string, isBranch: boolean, testId: string): ReactNode {
  if (!isBranch) return name;
  return (
    <BranchBadge branch={name} size="xs" className="max-w-full align-middle" data-testid={testId} />
  );
}

/**
 * What the send will do, step by step, with the lane and branches chosen above
 * (change factory-lanes): the one place that explains the route, at the bottom
 * of the dialog. Branches and the lane label show as chips.
 */
export function SendSummary({
  lane,
  base,
  baseIsBranch = true,
  finish,
  finishIsBranch = baseIsBranch,
  lanePrefix,
  fixed,
}: {
  /** The lane the issues go to, or null for none. */
  lane: { label: string; branch: string; isNew: boolean } | null;
  /** The branch runs (or the lane) start from, as a name to read. */
  base: string;
  /** `base` is a branch name, not a phrase such as "the repository's default branch". */
  baseIsBranch?: boolean;
  /** The branch the lane is finished into. */
  finish: string;
  /** `finish` is a branch name. */
  finishIsBranch?: boolean;
  lanePrefix: string;
  /** The lane exists: its branches are its own, not this send's. */
  fixed: boolean;
}) {
  const { t } = useTranslation();
  const baseChip = summaryBranch(base, baseIsBranch, 'issues-factory-summary-base');
  const finishChip = summaryBranch(finish, finishIsBranch, 'issues-factory-summary-finish');
  const laneChip = lane
    ? summaryBranch(lane.branch, true, 'issues-factory-summary-lane-branch')
    : null;
  const steps: { key: string; text: ReactNode }[] = lane
    ? [
        {
          key: 'label',
          text: withChips(
            (v) => t('factory.summaryLabel', 'The issues get the label {{label}}.', v),
            {
              label: (
                <LabelBadge
                  tone="info"
                  className="align-middle"
                  data-testid="issues-factory-summary-label"
                >
                  {lane.label}
                </LabelBadge>
              ),
            },
          ),
        },
        {
          key: 'lane',
          text: withChips(
            (v) =>
              lane.isNew
                ? t(
                    'factory.summaryLaneNew',
                    'The lane branch {{branch}} is created from {{base}} and kept up to date with it.',
                    v,
                  )
                : t(
                    'factory.summaryLaneExisting',
                    'The lane already has its branch, {{branch}}, kept up to date with {{base}}.',
                    v,
                  ),
            { branch: laneChip, base: baseChip },
          ),
        },
        {
          key: 'work',
          text: withChips(
            (v) =>
              t(
                'factory.summaryLaneWork',
                'Each issue is worked on its own branch, and its pull request goes into {{branch}}.',
                v,
              ),
            { branch: laneChip },
          ),
        },
        {
          key: 'finish',
          text: withChips(
            (v) =>
              t(
                'factory.summaryLaneFinish',
                'When the feature is ready, "Finish lane" in the factory settings opens one pull request from {{branch}} into {{finish}}, for a person to review and merge.',
                v,
              ),
            { branch: laneChip, finish: finishChip },
          ),
        },
      ]
    : [
        {
          key: 'work',
          text: withChips(
            (v) =>
              t(
                'factory.summaryNoLaneWork',
                'Each issue is worked on its own branch, started from {{base}}.',
                v,
              ),
            { base: baseChip },
          ),
        },
        {
          key: 'merge',
          text: withChips(
            (v) => t('factory.summaryNoLaneMerge', 'Its pull request goes into {{base}}.', v),
            { base: baseChip },
          ),
        },
        {
          key: 'keeps',
          text: t(
            'factory.summaryNoLaneKeeps',
            'An issue that already has a {{prefix}}… label goes to that lane instead.',
            { prefix: lanePrefix },
          ),
        },
      ];
  return (
    <div
      className="text-muted-foreground flex flex-col gap-1.5 border-t pt-2"
      data-testid="issues-factory-summary"
    >
      <p className="text-foreground flex items-center gap-1.5">
        <Info className="icon-xs shrink-0" aria-hidden />
        {t('factory.summaryTitle', 'What happens')}
      </p>
      <ol className="flex list-decimal flex-col gap-1 pl-5 leading-6">
        {steps.map((step) => (
          <li key={step.key}>{step.text}</li>
        ))}
      </ol>
      {fixed && (
        <p>{t('factory.routeLaneFixedNote', 'A lane keeps the branches it was created with.')}</p>
      )}
    </div>
  );
}
