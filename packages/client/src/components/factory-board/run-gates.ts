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

export function factoryRunGateChips(
  t: TFunction,
  run: Pick<FactoryRun, 'risk' | 'reviews' | 'regressionProof' | 'metrics' | 'state'>,
): FactoryGateChip[] {
  const head = headOf(run);
  const chips: FactoryGateChip[] = [];

  if (run.risk) {
    const high = run.risk.level === 'high';
    const chip: FactoryGateChip = {
      id: 'risk',
      tone: high ? 'warn' : 'pass',
      label: high ? t('factory.risk.high', 'High risk') : t('factory.risk.low', 'Low risk'),
      stale: false,
    };
    if (high && run.risk.reasons.length > 0) chip.detail = run.risk.reasons.join('\n');
    chips.push(chip);
  }

  const review = factoryRunReviewLabel(t, run);
  const lastReview = run.reviews.at(-1);
  if (review && lastReview) {
    chips.push({
      id: 'review',
      tone: review.passed ? 'pass' : 'fail',
      label: review.text,
      detail: short(lastReview.sha),
      stale: head !== null && lastReview.sha !== head,
    });
  }

  const proof = run.regressionProof;
  if (proof) {
    const labels = {
      pass: t('factoryBoard.proof.pass', 'Proof passed'),
      fail: t('factoryBoard.proof.fail', 'Proof failed'),
      skipped: t('factoryBoard.proof.skipped', 'No proof needed'),
    };
    chips.push({
      id: 'proof',
      tone: PROOF_TONE[proof.verdict],
      label: labels[proof.verdict],
      detail: proof.finding ?? short(proof.headSha),
      stale: head !== null && proof.headSha !== head,
    });
  }

  const { ciRounds, ciRed, conflicts } = run.metrics;
  if (ciRounds > 0 || run.state === 'waiting_ci') {
    const troubled = ciRed + conflicts > 0;
    const chip: FactoryGateChip = {
      id: 'ci',
      tone: troubled ? 'warn' : 'neutral',
      label:
        run.state === 'waiting_ci'
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
    chips.push(chip);
  }
  return chips;
}
