/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: adapter
 * @domain layer: application
 *
 * A member's merge approval of a high-risk change, followed to the commits it
 * covers (openspec factory-approval-survives-integration), and the risk
 * reasons that hold a merge when it does not.
 */

import type { FactoryMergeApproval } from '@funny/shared/contracts/factory';

import { log } from '../../../lib/logger.js';
import {
  approvalCovers,
  approvalGapOf,
  approvalMoveComment,
  type ApprovalCoverage,
  type ApprovalMove,
} from '../factory-approval-carry.js';
import { changeDeltaOnRunner, type ChangeDelta } from '../factory-step-runner.js';
import type { ActionCore } from './core.js';
import type { ClassifiedHead } from './shared.js';

/** What the approvals read of the rest of the provider. */
interface ApprovalLinks {
  classifyHead(): Promise<ClassifiedHead | null>;
}

/** Why a high-risk head is not merged by itself, and the approval moves that change it. */
export function createApprovalMoves(core: ActionCore, links: ApprovalLinks) {
  const { deps, scope, threadIds, state, count, pullRequest, reader } = core;
  const { classifyHead } = links;
  /**
   * Carry a member's approval of `from` to the base merge `to`, and say so like
   * any other move (D6): the change is the same, but no person approved `to`.
   */
  async function carryApprovalAcrossBaseMerge(from: string, to: string): Promise<void> {
    if (!(await deps.carryMergeApproval?.(from, to))) return;
    await count(state.metrics, { event: 'merge_approval_moved_same' });
    const approval = (await deps.mergeApproval?.()) ?? null;
    if (approval?.sha !== to) return;
    await announceApprovalMove({
      userId: approval.userId,
      from: approval.carriedFrom ?? from,
      to,
      kind: 'same',
      lines: 0,
      files: [],
    });
  }

  /**
   * Why the factory does not merge `sha` by itself: the reasons its change is
   * high risk, when no member approved it. Null when it may.
   */
  async function riskReasons(sha: string): Promise<string[] | null> {
    if (deps.autoMerge === 'all') return null;
    const change = await classifyHead();
    if (change?.sha !== sha || change.risk.level !== 'high') return null;
    if (await deps.mergeApproved?.(sha)) return null;
    const refusal = await approvalNotMoved(sha, change.risk.keys);
    if (refusal === null) return null;
    return refusal
      ? [...change.risk.reasons, `a member approved another commit, and ${refusal}`]
      : change.risk.reasons;
  }

  /** Why the approval of another commit does not cover a head, by `approved..head`: asked once. */
  const approvalRefusals = new Map<string, string>();

  /**
   * A member approved another commit of this pull request: move the approval
   * to `sha` when it covers it (openspec factory-approval-survives-integration,
   * D3). Null when `sha` is approved now; else why not ('' when there is no
   * approval to move). The delta is always taken from the commit the member
   * approved, so adjustments cannot add up.
   */
  async function approvalNotMoved(
    sha: string,
    riskKeys: readonly string[] | undefined,
  ): Promise<string | null> {
    const approval = (await deps.mergeApproval?.()) ?? null;
    if (!approval || approval.sha === sha) return '';
    const approved = approval.carriedFrom ?? approval.sha;
    const asked = `${approved}..${sha}`;
    const known = approvalRefusals.get(asked);
    if (known !== undefined) return known;
    const input = {
      delta: await changeSince(approved, sha),
      maxAdjustLines: deps.approvalAdjustMaxLines ?? 0,
      approvedRiskKeys: approval.riskKeys,
      riskKeys,
    };
    const coverage = approvalCovers(input);
    const reason = coverage.covers ? await moveApproval(approval, sha, coverage) : coverage.reason;
    if (reason !== null) approvalRefusals.set(asked, reason);
    // The member is asked again: keep what differs from the commit they read (D2).
    if (!coverage.covers) {
      await deps.noteApprovalGap?.(
        approval.sha,
        approvalGapOf(input, sha, coverage.reason, new Date().toISOString()),
      );
    }
    return reason;
  }

  /**
   * Move `approval` to `sha`, which it covers. Null when `sha` is approved now;
   * the move is a compare-and-set, so a new approval written meanwhile wins.
   */
  async function moveApproval(
    approval: FactoryMergeApproval,
    sha: string,
    { kind, lines, files }: Extract<ApprovalCoverage, { covers: true }>,
  ): Promise<string | null> {
    await deps.carryMergeApproval?.(approval.sha, sha, { kind, lines, files });
    await count(state.metrics, { event: `merge_approval_moved_${kind}` });
    if (!(await deps.mergeApproved?.(sha))) return 'the approval changed meanwhile';
    const from = approval.carriedFrom ?? approval.sha;
    await announceApprovalMove({ userId: approval.userId, from, to: sha, kind, lines, files });
    return null;
  }

  /**
   * Say where the approval went (D6): a comment on the pull request and a row
   * in the approver's activities. The stored move is the record; a comment
   * that fails is logged and never stops the merge.
   */
  async function announceApprovalMove(move: ApprovalMove): Promise<void> {
    await deps.onApprovalMoved?.(move);
    const pr = pullRequest();
    if (!pr) return;
    const commented = await deps.github.commentOnIssue(
      reader,
      pr.number,
      approvalMoveComment(move),
    );
    if (commented.isOk()) return;
    log.warn('Issue factory could not comment a moved merge approval on the pull request', {
      namespace: 'factory',
      runId: scope.runId,
      from: move.from,
      to: move.to,
      error: commented.error.message,
    });
  }

  /** How the pull request's change differs at `from` and at `to`, from the run's runner; null when it cannot say. */
  async function changeSince(from: string, to: string): Promise<ChangeDelta | null> {
    const pr = pullRequest();
    const threadId = threadIds[0];
    if (!pr || !threadId || !deps.steps) return null;
    const head = await deps.github.pullRequests.pullHead(pr);
    if (head.isErr()) return null;
    const delta = await changeDeltaOnRunner(
      deps.steps,
      threadId,
      { from, to, baseBranch: head.value.baseRef, branch: scope.branch },
      deps.signal,
    );
    if (delta.isErr()) {
      log.warn('Issue factory could not compare a change with its approved commit', {
        namespace: 'factory',
        runId: scope.runId,
        from,
        to,
        error: delta.error,
      });
      return null;
    }
    return delta.value;
  }

  return { riskReasons, carryApprovalAcrossBaseMerge };
}
