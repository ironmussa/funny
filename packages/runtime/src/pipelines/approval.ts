/**
 * Approval node — human-in-the-loop gate.
 *
 * Wraps the generic `node()` factory from @funny/pipelines into a node
 * that pauses pipeline execution until a human approves or rejects via
 * the runtime's approval channel (WS event + REST callback).
 *
 * Designed to match Archon's `approval:` node semantics so workflows
 * defined in either system share the same mental model:
 *
 *   Archon YAML                        | funny TS
 *   -----------------------------------|------------------------------------
 *   approval.message                   | ApprovalNodeOpts.message
 *   approval.capture_response          | ApprovalNodeOpts.captureResponse
 *   approval.on_reject (prompt)        | ApprovalNodeOpts.onReject (callback)
 *   $<node-id>.output (captured)       | ctx.approvalOutputs[name]
 *   $REJECTION_REASON                  | first arg to onReject(reason, ctx)
 *   workflow-level interactive: true   | implicit (funny pipelines are
 *                                      |   already foreground / WS-driven)
 *
 * Reference: https://github.com/coleam00/Archon
 */

import { node, type GuardFn, type PipelineNode } from '@funny/pipelines';

import type { PipelineContext } from './types.js';

// ── Errors ───────────────────────────────────────────────────

/**
 * Thrown by an approval node when the user rejects. The pipeline engine
 * treats this like any other thrown error: the run terminates with
 * `outcome: 'failed'` and `error` containing the rejection reason.
 */
export class ApprovalRejectedError extends Error {
  constructor(
    public readonly gateId: string,
    public readonly reason: string,
  ) {
    super(`Approval gate "${gateId}" rejected: ${reason}`);
    this.name = 'ApprovalRejectedError';
  }
}

/**
 * Thrown when an approval times out. Providers SHOULD throw this from
 * `requestApproval` when their `timeoutMs` is exceeded so callers can
 * distinguish timeout from rejection.
 */
export class ApprovalTimeoutError extends Error {
  constructor(
    public readonly gateId: string,
    public readonly timeoutMs: number,
  ) {
    super(`Approval gate "${gateId}" timed out after ${timeoutMs}ms`);
    this.name = 'ApprovalTimeoutError';
  }
}

// ── Context augmentation ─────────────────────────────────────

/**
 * Captured outputs from approval gates with `captureResponse: true`,
 * keyed by node name. Mirrors Archon's `$<node-id>.output` substitution.
 */
export interface ApprovalCapturedOutputs {
  approvalOutputs?: Record<string, string>;
}

// ── Options ──────────────────────────────────────────────────

export interface ApprovalNodeOpts<T extends PipelineContext> {
  /**
   * User-facing message shown in the approval UI. May be a function of
   * context — useful when the prompt depends on prior pipeline state
   * (e.g. include a diff summary, a verdict, or test output).
   */
  message: string | ((ctx: T) => string);
  /**
   * If true, the approver may attach a free-text comment which is stored
   * on `ctx.approvalOutputs[name]` for downstream nodes. Default: false.
   */
  captureResponse?: boolean;
  /**
   * Optional rejection handler. Runs *before* the node throws, receiving
   * the rejection reason and current context. Useful for logging or for
   * spawning a follow-up agent (mirrors Archon's `on_reject:` prompt).
   * Throwing from this handler is allowed — its error becomes the final
   * pipeline error, replacing `ApprovalRejectedError`.
   */
  onReject?: (rejectionReason: string, ctx: T) => void | Promise<void>;
  /**
   * Skip the approval entirely when this returns false. Useful for
   * conditional gates (e.g. only require approval for production pushes).
   */
  when?: GuardFn<T>;
  /**
   * Forwarded to `provider.requestApproval`. When the timeout elapses,
   * the provider throws `ApprovalTimeoutError`, which the engine treats
   * as a node failure. Default: no timeout. May be a function of context
   * to allow per-run configuration without losing type safety.
   */
  timeoutMs?: number | ((ctx: T) => number | undefined);
}

// ── Builder ─────────────────────────────────────────────────

/**
 * Build an approval node. Drop into any pipeline's `nodes` array exactly
 * like a regular `node()` — the engine handles it generically.
 *
 * Example:
 *
 * ```ts
 * definePipeline<MyCtx>({
 *   name: 'guarded-push',
 *   nodes: [
 *     node('build', ...),
 *     approvalNode<MyCtx>('confirm-push', {
 *       message: (ctx) => `About to push ${ctx.branch}. Continue?`,
 *       captureResponse: true,
 *       onReject: async (reason, ctx) => {
 *         await ctx.provider.notify({ message: `Push aborted: ${reason}`, level: 'warning' });
 *       },
 *     }),
 *     node('push', ...),
 *   ],
 * });
 * ```
 */
export function approvalNode<T extends PipelineContext>(
  name: string,
  opts: ApprovalNodeOpts<T>,
): PipelineNode<T> {
  return node<T>(
    name,
    async (ctx) => {
      const message = typeof opts.message === 'function' ? opts.message(ctx) : opts.message;

      ctx.progress.onStepProgress(name, { status: 'running' });

      const timeoutMs = typeof opts.timeoutMs === 'function' ? opts.timeoutMs(ctx) : opts.timeoutMs;

      ctx.progress.onStepProgress(name, {
        status: 'running',
        metadata: { workflowStatus: 'waiting_approval' },
      });

      const decision = await ctx.provider.requestApproval({
        gateId: name,
        message,
        captureResponse: opts.captureResponse,
        timeoutMs,
      });

      if (decision.decision === 'approve') {
        ctx.progress.onStepProgress(name, { status: 'completed' });

        if (opts.captureResponse) {
          const augmented = ctx as T & ApprovalCapturedOutputs;
          augmented.approvalOutputs = {
            ...(augmented.approvalOutputs ?? {}),
            [name]: decision.comment ?? '',
          };
          return augmented;
        }
        return ctx;
      }

      // Rejected — run on_reject hook (best-effort: hook errors propagate).
      const reason = decision.reason;
      if (opts.onReject) {
        await opts.onReject(reason, ctx);
      }

      ctx.progress.onStepProgress(name, { status: 'failed', error: reason });
      throw new ApprovalRejectedError(name, reason);
    },
    { when: opts.when },
  );
}
