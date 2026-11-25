/**
 * The quality gates a run has a result for, as chips on its board card
 * (openspec factory-pipeline-board): risk, the latest review, the regression
 * proof and CI. A gate the run has not reached has no chip, nor has a gate
 * whose result needs no look: a passed review of the head commit, a passed or
 * skipped proof (of any commit: the detail panel says which), and CI rounds
 * that are over (their history is in the detail panel; only running CI shows).
 */
import type { TFunction } from 'i18next';

import type { FactoryRun } from '@/lib/api/factory';
import type { FactoryWaitReason } from '@/lib/api/factory';
import {
  factoryRunReasonText,
  factoryRunReviewLabel,
  factoryWaitReasonText,
  isFactoryRunUnsavedWork,
} from '@/lib/factory-run-labels';

import { plainFactoryReason } from './run-dependencies';
import { factoryRunWaitingText } from './run-waiting';

export type FactoryGateId = 'wait' | 'problem' | 'risk' | 'review' | 'proof' | 'ci';
export type FactoryGateTone = 'pass' | 'fail' | 'warn' | 'neutral';

export interface FactoryGateChip {
  id: FactoryGateId;
  tone: FactoryGateTone;
  label: string;
  /** Shown on hover: the reasons, the commit, the counts. */
  detail?: string;
  /** The result is for an older commit than the pull request's head. */
  stale: boolean;
}

const short = (sha: string) => sha.slice(0, 7);

const PROOF_TONE: Record<'pass' | 'fail' | 'skipped', FactoryGateTone> = {
  pass: 'pass',
  fail: 'fail',
  skipped: 'neutral',
};

/** The pull request's head as the run knows it: its last classified commit, else its last reviewed or proved one. */
function headOf(run: Pick<FactoryRun, 'risk' | 'reviews' | 'regressionProof'>): string | null {
  return run.risk?.headSha ?? run.reviews.at(-1)?.sha ?? run.regressionProof?.headSha ?? null;
}

type GateRun = Pick<
  FactoryRun,
  | 'risk'
  | 'reviews'
  | 'regressionProof'
  | 'metrics'
  | 'state'
  | 'failureReason'
  | 'currentStep'
  | 'waitReason'
  | 'triage'
>;

/**
 * The merge gate parked the run for its risk. Its card then says so on the
 * High risk chip's tooltip instead of in a line of its own.
 */
export function isFactoryRunHeldForRisk(run: Pick<FactoryRun, 'state' | 'failureReason'>): boolean {
  return run.state === 'waiting_human' && run.failureReason === 'high risk';
}

/**
 * The run waits for a person for a recorded reason, which a chip carries (the
 * High risk chip, the failed review's, or the problem chip), so the card has
 * no line for it.
 */
function isFactoryRunReasonOnChip(run: Pick<FactoryRun, 'state' | 'failureReason'>): boolean {
  return run.state === 'waiting_human' && run.failureReason !== null;
}

/**
 * What stopped a parked run, as a red chip whose tooltip is the full reason.
 * A risk hold and a failed review have their own chip, so they have none.
 */
function problemChip(t: TFunction, run: GateRun): FactoryGateChip | null {
  const reason = run.failureReason;
  if (!isFactoryRunReasonOnChip(run) || !reason) return null;
  if (reason === 'high risk' || reason === 'review failed') return null;
  const labels = new Map([
    ['no review', t('factoryBoard.problem.noReview', 'No review')],
    ['branch history rewritten', t('factoryBoard.problem.rewritten', 'Branch rewritten')],
    ['review gave no verdict', t('factoryBoard.problem.noVerdict', 'No verdict')],
  ]);
  // A step's failure is recorded as `<step>[<action>] failed: …`.
  const step = run.currentStep ?? /^([\w-]+)\[[^\]]*\] failed/.exec(reason)?.[1] ?? null;
  const label = isFactoryRunUnsavedWork(run)
    ? t('factoryBoard.problem.noCommit', 'No commit')
    : (labels.get(reason) ??
      (step
        ? t('factoryBoard.problem.stepFailed', '{{step}} failed', { step })
        : t('factoryBoard.problem.other', 'Problem')));
  const detail = plainFactoryReason(
    factoryRunWaitingText(t, run) ?? factoryRunReasonText(t, reason),
  );
  return {
    id: 'problem',
    tone: 'fail',
    label,
    detail: detail.length > 600 ? `${detail.slice(0, 599)}…` : detail,
    stale: false,
  };
}

function riskChip(t: TFunction, run: GateRun): FactoryGateChip | null {
  const risk = run.risk;
  if (!risk) return null;
  const high = risk.level === 'high';
  const chip: FactoryGateChip = {
    id: 'risk',
    tone: high ? 'warn' : 'pass',
    label: high ? t('factory.risk.high', 'High risk') : t('factory.risk.low', 'Low risk'),
    stale: false,
  };
  const lines = [
    ...(isFactoryRunHeldForRisk(run) && run.failureReason
      ? [factoryRunReasonText(t, run.failureReason)]
      : []),
    ...(high ? risk.reasons : []),
  ];
  if (lines.length > 0) chip.detail = lines.join('\n');
  return chip;
}

function reviewChip(t: TFunction, run: GateRun, head: string | null): FactoryGateChip | null {
  const review = factoryRunReviewLabel(t, run);
  const last = run.reviews.at(-1);
  if (!review || !last) return null;
  return {
    id: 'review',
    tone: review.passed ? 'pass' : 'fail',
    label: review.text,
    detail: short(last.sha),
    stale: head !== null && last.sha !== head,
  };
}

function proofChip(
  t: TFunction,
  proof: NonNullable<FactoryRun['regressionProof']>,
  head: string | null,
): FactoryGateChip {
  const labels = {
    pass: t('factoryBoard.proof.pass', 'Proof passed'),
    fail: t('factoryBoard.proof.fail', 'Proof failed'),
    skipped: t('factoryBoard.proof.skipped', 'No proof needed'),
  };
  return {
    id: 'proof',
    tone: PROOF_TONE[proof.verdict],
    label: labels[proof.verdict],
    detail: proof.finding ?? short(proof.headSha),
    stale: head !== null && proof.headSha !== head,
  };
}

/** CI shows only while it runs; how many rounds it took is in the detail panel. */
function ciChip(t: TFunction, run: GateRun): FactoryGateChip | null {
  if (run.state !== 'waiting_ci') return null;
  const { ciRounds, ciRed, conflicts } = run.metrics;
  const chip: FactoryGateChip = {
    id: 'ci',
    tone: 'neutral',
    label: t('factoryBoard.ci.running', 'CI running'),
    stale: false,
  };
  if (ciRounds > 0) {
    chip.detail = t(
      'factoryBoard.ci.roundsDetail',
      'Round {{round}} · {{red}} red · {{conflicts}} conflicts',
      {
        round: ciRounds + 1,
        red: ciRed,
        conflicts,
      },
    );
  }
  return chip;
}

/** A review chip only says something when it failed or is for an older commit. */
function reviewWorthShowing(chip: FactoryGateChip | null): FactoryGateChip | null {
  if (!chip || chip.stale) return chip;
  return chip.tone === 'fail' ? chip : null;
}

/** A proof chip only says something when it failed. */
function proofWorthShowing(chip: FactoryGateChip | null): FactoryGateChip | null {
  return chip?.tone === 'fail' ? chip : null;
}

/** Why a queued run waits that is a problem (it will not start by itself), not a turn in line. */
const BLOCKING_WAITS: ReadonlySet<FactoryWaitReason['kind']> = new Set([
  'blocker-not-sent',
  'blocker-failed',
  'circular',
  'blockers-unreadable',
  'proof-not-configured',
]);

function waitLabel(t: TFunction, reason: FactoryWaitReason): string {
  const [first] = reason.blockers;
  const more = reason.blockers.length - 1;
  const issues = first === undefined ? '' : more > 0 ? `#${first} +${more}` : `#${first}`;
  switch (reason.kind) {
    case 'blocker-not-sent':
    case 'blocker-failed':
    case 'blocker-other-repo':
      return t('factoryBoard.wait.blockedBy', 'Blocked by {{issues}}', { issues });
    case 'blocker-in-progress':
    case 'blocker-waiting-merge':
      return t('factoryBoard.wait.after', 'After {{issues}}', { issues });
    case 'paths-overlap':
    case 'paths-awaiting-approval':
      return t('factoryBoard.wait.sameFiles', 'Same files as {{issues}}', { issues });
    case 'circular':
      return t('factoryBoard.wait.circular', 'Circular dependency');
    case 'blockers-unreadable':
      return t('factoryBoard.wait.unreadable', 'Blockers unreadable');
    case 'proof-not-configured':
      return t('factoryBoard.wait.noProofRules', 'No proof rules');
    case 'no-free-slot':
      return t('factoryBoard.wait.noFreeSlot', 'No free slot');
  }
}

/** Why a queued run is not admitted yet: red when it will not start by itself. */
function waitChip(t: TFunction, run: GateRun): FactoryGateChip | null {
  if (run.state !== 'requested' || !run.waitReason) return null;
  const kind = run.waitReason.kind;
  return {
    id: 'wait',
    tone: BLOCKING_WAITS.has(kind)
      ? 'fail'
      : kind === 'paths-awaiting-approval'
        ? 'warn'
        : 'neutral',
    label: waitLabel(t, run.waitReason),
    detail: factoryWaitReasonText(t, run.waitReason),
    stale: false,
  };
}

export function factoryRunGateChips(t: TFunction, run: GateRun): FactoryGateChip[] {
  const head = headOf(run);
  const chips = [
    waitChip(t, run),
    problemChip(t, run),
    riskChip(t, run),
    reviewWorthShowing(reviewChip(t, run, head)),
    proofWorthShowing(run.regressionProof ? proofChip(t, run.regressionProof, head) : null),
    ciChip(t, run),
  ];
  return chips.filter((chip) => chip !== null);
}
