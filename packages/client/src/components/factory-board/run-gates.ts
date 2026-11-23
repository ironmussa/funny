/**
 * The quality gates a run has a result for, as chips on its board card
 * (openspec factory-pipeline-board): risk, the latest review, the regression
 * proof and CI. A gate the run has not reached has no chip.
 */
import type { TFunction } from 'i18next';

import type { FactoryRun } from '@/lib/api/factory';
import { factoryRunReviewLabel } from '@/lib/factory-run-labels';

export type FactoryGateId = 'risk' | 'review' | 'proof' | 'ci';
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

type GateRun = Pick<FactoryRun, 'risk' | 'reviews' | 'regressionProof' | 'metrics' | 'state'>;

function riskChip(t: TFunction, risk: NonNullable<FactoryRun['risk']>): FactoryGateChip {
  const high = risk.level === 'high';
  const chip: FactoryGateChip = {
    id: 'risk',
    tone: high ? 'warn' : 'pass',
    label: high ? t('factory.risk.high', 'High risk') : t('factory.risk.low', 'Low risk'),
    stale: false,
  };
  if (high && risk.reasons.length > 0) chip.detail = risk.reasons.join('\n');
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

function ciChip(t: TFunction, run: GateRun): FactoryGateChip | null {
  const { ciRounds, ciRed, conflicts } = run.metrics;
  const running = run.state === 'waiting_ci';
  if (ciRounds === 0 && !running) return null;
  const troubled = ciRed + conflicts > 0;
  const chip: FactoryGateChip = {
    id: 'ci',
    tone: troubled ? 'warn' : 'neutral',
    label: running
      ? t('factoryBoard.ci.running', 'CI running')
      : t('factoryBoard.ci.rounds', 'CI ×{{count}}', { count: ciRounds }),
    stale: false,
  };
  if (troubled) {
    chip.detail = t('factoryBoard.ci.detail', '{{red}} red · {{conflicts}} conflicts', {
      red: ciRed,
      conflicts,
    });
  }
  return chip;
}

export function factoryRunGateChips(t: TFunction, run: GateRun): FactoryGateChip[] {
  const head = headOf(run);
  const chips = [
    run.risk ? riskChip(t, run.risk) : null,
    reviewChip(t, run, head),
    run.regressionProof ? proofChip(t, run.regressionProof, head) : null,
    ciChip(t, run),
  ];
  return chips.filter((chip) => chip !== null);
}
