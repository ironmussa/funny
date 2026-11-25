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
 *   only in files the approved change touched or files the base brought, with
 *   no risk reason the approved commit did not have. Covered only when the
 *   factory sets a limit.
 *
 * A file the base brought (openspec factory-approval-follows-base-code): the
 * base changed it after the approved commit split from it, and the change only
 * fixes the base's new lines there. The limit counts an edit that moved with
 * its code into such a file once (`linesAcrossMoves`). A runner that does not
 * report them leaves the file-by-file rule: no file outside the approved change.
 * - Anything else, and anything that could not be compared, is not covered.
 */

import { MAX_APPROVAL_GAP_FILES, type FactoryApprovalGap } from '@funny/shared/contracts/factory';

import type { ChangeDelta } from './factory-step-runner.js';

export type ApprovalCoverage =
  | {
      covers: true;
      kind: 'same' | 'adjustment';
      lines: number;
      files: string[];
      /** Of `files`, the ones the approved change did not touch and the base brought. */
      baseFiles: string[];
    }
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

/** The lines the limit counts: without the edits that moved with their code, when the runner says. */
const adjustmentLines = (delta: ChangeDelta) => delta.linesAcrossMoves ?? delta.lines;

/** The files outside the approved change that the base did not bring. */
const notBrought = (delta: ChangeDelta) => {
  const brought = new Set(delta.baseBrought ?? []);
  return delta.outsideFrom.filter((path) => !brought.has(path));
};

/** The adjustment's own conditions, once its size is known to be over zero. */
function adjustmentRefusal(input: ApprovalCoverageInput, delta: ChangeDelta): string | null {
  const lines = adjustmentLines(delta);
  if (input.maxAdjustLines <= 0) {
    return `the change differs from the approved commit by ${linesOf(lines)}`;
  }
  if (lines > input.maxAdjustLines) {
    return `the change differs from the approved commit by ${linesOf(lines)}; this factory follows ${input.maxAdjustLines}`;
  }
  if (delta.filesTruncated) return 'the change differs from the approved commit in too many files';
  const outside = notBrought(delta);
  if (outside.length > 0) {
    return `the change now touches ${outside[0]}, which the approved commit did not and the base did not bring`;
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
  if (delta.lines === 0) return { covers: true, kind: 'same', lines: 0, files: [], baseFiles: [] };
  const reason = adjustmentRefusal(input, delta);
  if (reason) return refused(reason);
  return {
    covers: true,
    kind: 'adjustment',
    lines: adjustmentLines(delta),
    files: delta.files.map((file) => file.path),
    baseFiles: delta.outsideFrom.filter((path) => (delta.baseBrought ?? []).includes(path)),
  };
}

/**
 * What a hold says changed since the approved commit, when the approval does
 * not cover `to` (openspec factory-merge-fewer-bounces, D2): the same facts
 * `approvalCovers` decided from, kept for the member instead of dropped.
 */
export function approvalGapOf(
  input: ApprovalCoverageInput,
  to: string,
  reason: string,
  at: string,
): FactoryApprovalGap {
  const { delta } = input;
  const paths = delta?.files.map((file) => file.path) ?? [];
  const files = paths.slice(0, MAX_APPROVAL_GAP_FILES);
  const outside = new Set(delta?.outsideFrom ?? []);
  const brought = new Set(delta?.baseBrought ?? []);
  const approved = new Set(input.approvedRiskKeys ?? []);
  const newFiles = files.filter((path) => outside.has(path));
  return {
    to,
    at,
    // A branch that lost the approved commit was compared with nothing a member read.
    lines: delta?.ancestor ? adjustmentLines(delta) : null,
    files,
    moreFiles: paths.length - files.length,
    newFiles,
    baseFiles: newFiles.filter((path) => brought.has(path)),
    newRiskKeys: input.approvedRiskKeys
      ? (input.riskKeys ?? []).filter((key) => !approved.has(key))
      : [],
    reason,
  };
}

/** A merge approval that moved from the commit a member approved to another. */
export interface ApprovalMove {
  /** Who approved. */
  userId: string;
  /** The commit they approved. */
  from: string;
  /** The commit the approval covers now. */
  to: string;
  kind: 'same' | 'adjustment';
  lines: number;
  files: string[];
  /** Of `files`, the ones the approved change did not touch and the base brought. */
  baseFiles: string[];
}

const short = (sha: string) => sha.slice(0, 7);
const SHOWN_FILES = 20;

/** One line saying the move, for the approver's activities and the log. */
export function approvalMoveTitle(move: ApprovalMove, issueNumber: number | null): string {
  const what = issueNumber ? ` of #${issueNumber}` : '';
  const how =
    move.kind === 'same'
      ? 'same change'
      : `${linesOf(move.lines)} ${move.lines === 1 ? 'differs' : 'differ'}`;
  return `Merge approval${what} moved from ${short(move.from)} to ${short(move.to)} (${how})`;
}

/**
 * What the pull request is told when an approval moves: which commit a person
 * approved, which one merges on it, and what differs. It says it is automated
 * and that nobody approved the new commit, so the page does not read as a
 * second approval.
 */
export function approvalMoveComment(move: ApprovalMove): string {
  const head = `A member approved merging this high-risk change at ${short(move.from)}. The factory moved that approval to ${short(move.to)}.`;
  const automated =
    'This comment is automated: no person approved the new commit. Its review and its checks still have to pass before it merges.';
  if (move.kind === 'same') {
    return [
      head,
      `The pull request adds and removes the same lines at both commits: ${short(move.to)} only brings the base branch in.`,
      automated,
    ].join('\n\n');
  }
  const brought = new Set(move.baseFiles);
  const listed = (files: string[]) => {
    const shown = files.slice(0, SHOWN_FILES).map((file) => `- \`${file}\``);
    if (files.length > SHOWN_FILES) shown.push(`- … and ${files.length - SHOWN_FILES} more`);
    return shown.join('\n');
  };
  const touched = move.files.filter((file) => !brought.has(file));
  const parts = [
    head,
    `The change differs from the approved one by ${linesOf(move.lines)}, with no new risk reason.`,
  ];
  if (touched.length > 0) {
    parts.push(`In files the approved change already touched:\n${listed(touched)}`);
  }
  if (move.baseFiles.length > 0) {
    parts.push(
      `In code the base branch brought after the approval, which the change now also fixes:\n${listed(move.baseFiles)}`,
    );
  }
  return [...parts, automated].join('\n\n');
}
