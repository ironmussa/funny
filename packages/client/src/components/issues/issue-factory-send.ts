/**
 * The decisions of the "Send to the issue factory" dialog (change
 * factory-lanes), without React: which lane a choice names, the branches a
 * send reads, the blockers it waits on, and how its result is reported.
 */
import type { FactoryLane } from '@funny/shared/contracts/factory';
import type { TFunction } from 'i18next';

import { toast } from '@/components/ui/toast';
import type { FactorySettings, FactorySubmitResult } from '@/lib/api/factory';

/** The lane select's value for "leave the issues' labels as they are". */
export const KEEP_LANE = '__keep__';
/** The lane select's value for "a lane that does not exist yet". */
export const NEW_LANE = '__new__';

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

/** The lane the send puts the issues in: null keeps their labels as they are. */
function chosenLaneName(choice: string, newLane: string): string | null {
  if (choice === KEEP_LANE) return null;
  return choice === NEW_LANE ? laneNameFrom(newLane) : choice;
}

/** The lanes issues can still be sent to. */
export function activeLanesOf(lanes: readonly FactoryLane[] | undefined): FactoryLane[] {
  return (lanes ?? []).filter((lane) => lane.state === 'active');
}

/** The lane part of a send, as the dialog's lane select and name input chose it. */
export interface SendLaneChoice {
  /** The lane's name; null for no lane, or a new lane whose name is not usable. */
  name: string | null;
  /** The GitHub label that puts an issue in the lane; null for no lane. */
  label: string | null;
  /** "New lane" is chosen and its name cannot name a lane. */
  invalid: boolean;
  /** The existing lane the issues go to; null for no lane or a new one. */
  existing: FactoryLane | null;
}

export function sendLaneChoice(
  activeLanes: readonly FactoryLane[],
  choice: string,
  newLane: string,
  labelPrefix: string,
): SendLaneChoice {
  const name = chosenLaneName(choice, newLane);
  return {
    name,
    label: name === null ? null : `${labelPrefix}${name}`,
    invalid: choice === NEW_LANE && name === null,
    existing: activeLanes.find((lane) => lane.name === choice) ?? null,
  };
}

/** The lane as the send summary shows it, or null without one. */
export function summaryLaneOf(
  lane: SendLaneChoice,
  laneBranchPrefix: string,
): { label: string; branch: string; isNew: boolean } | null {
  if (!lane.label || !lane.name) return null;
  return {
    label: lane.label,
    branch: lane.existing?.branch ?? `${laneBranchPrefix}${lane.name}`,
    isNew: lane.existing === null,
  };
}

/** The branches a send reads: '' is the repository default / the same as the base. */
export interface SendBranches {
  base: string;
  finish: string;
  /** `base` resolves to a branch name, not only to "the repository's default branch". */
  baseIsBranch: boolean;
  finishIsBranch: boolean;
}

/** An existing lane's own branches, else the ones chosen in the dialog. */
export function sendBranchesOf(
  existingLane: FactoryLane | null,
  settings: Pick<FactorySettings, 'baseBranch' | 'laneFinishBranch'>,
  route: { base: string; finish: string },
  defaultBranch: string | undefined,
): SendBranches {
  const { base, finish } = existingLane ? laneBranches(existingLane, settings) : route;
  const baseIsBranch = !!(base || defaultBranch);
  return { base, finish, baseIsBranch, finishIsBranch: !!finish || baseIsBranch };
}

function laneBranches(
  lane: FactoryLane,
  settings: Pick<FactorySettings, 'baseBranch' | 'laneFinishBranch'>,
) {
  return {
    base: lane.baseBranch ?? settings.baseBranch,
    finish: lane.finishBranch ?? settings.laneFinishBranch,
  };
}

/** The blockers of the selection that are neither in the factory nor selected. */
export function blockersOutside(
  blockers:
    | ReadonlyArray<{ blockers: ReadonlyArray<{ issue: number; inFactory: boolean }> }>
    | undefined,
  selected: readonly number[],
): number[] {
  const outside = (blockers ?? []).flatMap((entry) =>
    entry.blockers.filter((b) => !b.inFactory && !selected.includes(b.issue)).map((b) => b.issue),
  );
  return [...new Set(outside)];
}

/** Why the send button is off, or null. */
export function sendBlockedReason(t: TFunction, settings: FactorySettings): string | null {
  if (!settings.enabled) {
    return t('factory.pausedSend', 'The factory is paused. Resume it in the project settings.');
  }
  return settings.blockedReason;
}

export function reportSend(t: TFunction, result: FactorySubmitResult): void {
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
