/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: domain-service
 * @domain layer: domain
 *
 * Whether a member's approval to merge a high-risk commit covers another
 * commit of the same pull request (openspec
 * factory-approval-survives-integration, D3). The approval named one commit,
 * and a base merge or a small fix made another: asking the member again for a
 * change they already read stopped most approved runs from merging.
 *
 * The decision is made from the change's delta (what the pull request adds and
 * removes at the approved commit against what it does at the new one, computed
 * on the runner) and from the two risk classifications. Pure: no I/O.
 *
 * - `same`: the new commit descends from the approved one and the change is
 *   the same. Always covered.
 * - `adjustment`: the change differs by at most the factory's limit of lines,
 *   only in files the approved change touched, with no risk reason the approved
 *   commit did not have. Covered only when the factory sets a limit.
 * - Anything else, and anything that could not be compared, is not covered.
 */

import type { ChangeDelta } from './factory-step-runner.js';

export type ApprovalCoverage =
  | { covers: true; kind: 'same' | 'adjustment'; lines: number; files: string[] }
  | { covers: false; reason: string };

export interface ApprovalCoverageInput {
  /** The change's delta from the approved commit to the new one; null when it is not available. */
  delta: ChangeDelta | null;
  /** The largest adjustment the factory lets an approval follow, in lines; 0 is none. */
  maxAdjustLines: number;
  /** The risk keys the approved commit had; absent on an approval recorded before they existed. */
  approvedRiskKeys?: readonly string[];
  /** The risk keys of the new commit. */
  riskKeys?: readonly string[];
}

const refused = (reason: string): ApprovalCoverage => ({ covers: false, reason });

const linesOf = (count: number) => `${count} line${count === 1 ? '' : 's'}`;

/** The adjustment's own conditions, once its size is known to be over zero. */
function adjustmentRefusal(input: ApprovalCoverageInput, delta: ChangeDelta): string | null {
  if (input.maxAdjustLines <= 0) {
    return `the change differs from the approved commit by ${linesOf(delta.lines)}`;
  }
  if (delta.lines > input.maxAdjustLines) {
    return `the change differs from the approved commit by ${linesOf(delta.lines)}; this factory follows ${input.maxAdjustLines}`;
  }
  if (delta.filesTruncated) return 'the change differs from the approved commit in too many files';
  if (delta.outsideFrom.length > 0) {
    return `the change now touches ${delta.outsideFrom[0]}, which the approved commit did not`;
  }
  if (!input.approvedRiskKeys || !input.riskKeys) {
    return 'the risk reasons of the approved commit were not recorded';
  }
  const approved = new Set(input.approvedRiskKeys);
  const added = input.riskKeys.find((key) => !approved.has(key));
  return added ? `the change has a risk reason the approved commit did not have (${added})` : null;
}

export function approvalCovers(input: ApprovalCoverageInput): ApprovalCoverage {
  const { delta } = input;
  if (!delta) return refused('the change could not be compared with the approved commit');
  if (!delta.ancestor) return refused('the branch no longer contains the approved commit');
  if (delta.lines === 0) return { covers: true, kind: 'same', lines: 0, files: [] };
  const reason = adjustmentRefusal(input, delta);
  if (reason) return refused(reason);
  return {
    covers: true,
    kind: 'adjustment',
    lines: delta.lines,
    files: delta.files.map((file) => file.path),
  };
}
