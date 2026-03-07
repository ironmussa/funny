/**
 * @domain subdomain: Shared Kernel
 * @domain type: adapter
 * @domain layer: infrastructure
 *
 * Reactive telemetry handler — emits metrics and spans for git operations
 * via the ThreadEventBus so they appear in Abbacchio traces/metrics.
 *
 * Git operation spans are linked to the active agent run trace (if any)
 * via getThreadTrace(), creating proper parent-child relationships.
 */

import { metric, startSpan, getThreadTrace } from '../../lib/telemetry.js';
import type { EventHandler } from './types.js';

/** Build span opts that link to the active thread trace (if any) */
function threadSpanOpts(threadId: string, extraAttrs?: Record<string, string>) {
  const trace = getThreadTrace(threadId);
  return {
    traceId: trace?.traceId,
    parentSpanId: trace?.spanId,
    attributes: { threadId, ...extraAttrs },
  };
}

export const gitCommitTelemetryHandler: EventHandler<'git:committed'> = {
  name: 'telemetry:git-commit',
  event: 'git:committed',
  action(payload) {
    const span = startSpan(
      'git.commit',
      threadSpanOpts(payload.threadId, { amend: String(!!payload.amend) }),
    );
    span.end('ok');
    metric('git.operations', 1, { type: 'sum', attributes: { operation: 'commit' } });
  },
};

export const gitPushTelemetryHandler: EventHandler<'git:pushed'> = {
  name: 'telemetry:git-push',
  event: 'git:pushed',
  action(payload) {
    const span = startSpan('git.push', threadSpanOpts(payload.threadId));
    span.end('ok');
    metric('git.operations', 1, { type: 'sum', attributes: { operation: 'push' } });
  },
};

export const gitMergeTelemetryHandler: EventHandler<'git:merged'> = {
  name: 'telemetry:git-merge',
  event: 'git:merged',
  action(payload) {
    const span = startSpan(
      'git.merge',
      threadSpanOpts(payload.threadId, {
        sourceBranch: payload.sourceBranch,
        targetBranch: payload.targetBranch,
      }),
    );
    span.end('ok');
    metric('git.operations', 1, { type: 'sum', attributes: { operation: 'merge' } });
  },
};

export const gitPullTelemetryHandler: EventHandler<'git:pulled'> = {
  name: 'telemetry:git-pull',
  event: 'git:pulled',
  action(payload) {
    const span = startSpan('git.pull', threadSpanOpts(payload.threadId));
    span.end('ok');
    metric('git.operations', 1, { type: 'sum', attributes: { operation: 'pull' } });
  },
};

export const gitStageTelemetryHandler: EventHandler<'git:staged'> = {
  name: 'telemetry:git-stage',
  event: 'git:staged',
  action(payload) {
    metric('git.operations', 1, {
      type: 'sum',
      attributes: { operation: 'stage', fileCount: String(payload.paths.length) },
    });
  },
};

export const gitUnstageTelemetryHandler: EventHandler<'git:unstaged'> = {
  name: 'telemetry:git-unstage',
  event: 'git:unstaged',
  action(payload) {
    metric('git.operations', 1, {
      type: 'sum',
      attributes: { operation: 'unstage', fileCount: String(payload.paths.length) },
    });
  },
};

export const gitRevertTelemetryHandler: EventHandler<'git:reverted'> = {
  name: 'telemetry:git-revert',
  event: 'git:reverted',
  action(payload) {
    metric('git.operations', 1, {
      type: 'sum',
      attributes: { operation: 'revert', fileCount: String(payload.paths.length) },
    });
  },
};

export const gitStashTelemetryHandler: EventHandler<'git:stashed'> = {
  name: 'telemetry:git-stash',
  event: 'git:stashed',
  action() {
    metric('git.operations', 1, { type: 'sum', attributes: { operation: 'stash' } });
  },
};

export const gitStashPopTelemetryHandler: EventHandler<'git:stash-popped'> = {
  name: 'telemetry:git-stash-pop',
  event: 'git:stash-popped',
  action() {
    metric('git.operations', 1, { type: 'sum', attributes: { operation: 'stash-pop' } });
  },
};

export const gitResetSoftTelemetryHandler: EventHandler<'git:reset-soft'> = {
  name: 'telemetry:git-reset-soft',
  event: 'git:reset-soft',
  action() {
    metric('git.operations', 1, { type: 'sum', attributes: { operation: 'reset-soft' } });
  },
};
