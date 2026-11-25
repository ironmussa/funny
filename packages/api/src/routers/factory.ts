import {
  factoryBlockersInput,
  factoryFlowInput,
  factoryApprovalRequestInput,
  factoryApproveMergeInput,
  factoryLintCleanupInput,
  factoryProjectInput,
  factoryRunInput,
  factoryTriggerInput,
  runFactoryFlowInput,
  saveFactorySettingsInput,
  saveFactoryTriggerInput,
  submitFactoryIssuesInput,
} from '@funny/shared/contracts/factory';

import { unwrap } from '../failure.js';
import { projectProcedure, protectedProcedure, router } from '../trpc.js';

const SAVE_FORBIDDEN = 'Running an issue factory needs contributor access to the project';
const CONTROL_FORBIDDEN = 'Controlling factory runs needs contributor access to the project';
const SEND_FORBIDDEN = 'Sending issues to a factory needs contributor access to the project';
const TRIGGER_FORBIDDEN = 'Changing a factory trigger needs contributor access to the project';
const RUN_FORBIDDEN = 'Starting a factory flow needs contributor access to the project';

// The caller's own issue factory for a project (change issue-factory). Saving
// needs `steer`, the capability of starting threads: the factory starts them
// in the caller's name.
export const factoryRouter = router({
  settings: projectProcedure('view')
    .input(factoryProjectInput)
    .query(async ({ ctx, input }) =>
      unwrap(await ctx.ports.factory.settings(ctx.userId, input.projectId)),
    ),
  save: projectProcedure('steer', SAVE_FORBIDDEN)
    .input(saveFactorySettingsInput)
    .mutation(async ({ ctx, input: { projectId, ...data } }) =>
      unwrap(await ctx.ports.factory.save(ctx.userId, projectId, data)),
    ),
  runs: projectProcedure('view')
    .input(factoryProjectInput)
    .query(async ({ ctx, input }) =>
      unwrap(await ctx.ports.factory.runs(ctx.userId, input.projectId)),
    ),
  // The caller's own runs across projects (thread lists show their threads as
  // busy). Scoped by factory owner, so it needs no project capability.
  activeRuns: protectedProcedure.query(async ({ ctx }) =>
    unwrap(await ctx.ports.factory.activeRuns(ctx.userId)),
  ),
  // The factory view: the caller's own runs across projects, queued ones too.
  // Scoped by factory owner, like `activeRuns`.
  queueRuns: protectedProcedure.query(async ({ ctx }) =>
    unwrap(await ctx.ports.factory.queueRuns(ctx.userId)),
  ),
  // Stopping or retrying acts on the caller's own factory, which runs in their
  // name: the same `steer` as saving it.
  stopRun: projectProcedure('steer', CONTROL_FORBIDDEN)
    .input(factoryRunInput)
    .mutation(async ({ ctx, input }) =>
      unwrap(await ctx.ports.factory.stopRun(ctx.userId, input.projectId, input.runId)),
    ),
  retryRun: projectProcedure('steer', CONTROL_FORBIDDEN)
    .input(factoryRunInput)
    .mutation(async ({ ctx, input }) =>
      unwrap(await ctx.ports.factory.retryRun(ctx.userId, input.projectId, input.runId)),
    ),
  // A member's approval of a high-risk change the factory held: the factory
  // then merges that commit in their name, like everything else it does.
  approveMerge: projectProcedure('steer', CONTROL_FORBIDDEN)
    .input(factoryApproveMergeInput)
    .mutation(async ({ ctx, input }) =>
      unwrap(
        await ctx.ports.factory.approveMerge(
          ctx.userId,
          input.projectId,
          input.runId,
          input.expectedSha,
        ),
      ),
    ),
  // A member agrees with the agent that the issue needs no change.
  markRunDone: projectProcedure('steer', CONTROL_FORBIDDEN)
    .input(factoryRunInput)
    .mutation(async ({ ctx, input }) =>
      unwrap(await ctx.ports.factory.markRunDone(ctx.userId, input.projectId, input.runId)),
    ),
  // A member closes the pull request a replaced run left open. The server
  // decides again that the run was replaced; the board only offers it.
  closeReplacedPr: projectProcedure('steer', CONTROL_FORBIDDEN)
    .input(factoryRunInput)
    .mutation(async ({ ctx, input }) =>
      unwrap(await ctx.ports.factory.closeReplacedPr(ctx.userId, input.projectId, input.runId)),
    ),
  // A member's statement that a run only clears lint warnings: its size then
  // does not hold it. Like an approval, it comes from a member's session only.
  setLintCleanup: projectProcedure('steer', CONTROL_FORBIDDEN)
    .input(factoryLintCleanupInput)
    .mutation(async ({ ctx, input }) =>
      unwrap(
        await ctx.ports.factory.setLintCleanup(
          ctx.userId,
          input.projectId,
          input.runId,
          input.lintCleanup,
        ),
      ),
    ),
  // What agents asked the caller to approve (openspec factory-agent-tools). A
  // request is answered by approving the run with `approveMerge`, or declined
  // here; there is no procedure that approves a request.
  approvalRequests: projectProcedure('view')
    .input(factoryProjectInput)
    .query(async ({ ctx, input }) =>
      unwrap(await ctx.ports.factory.approvalRequests(ctx.userId, input.projectId)),
    ),
  declineApprovalRequest: projectProcedure('steer', CONTROL_FORBIDDEN)
    .input(factoryApprovalRequestInput)
    .mutation(async ({ ctx, input }) =>
      unwrap(
        await ctx.ports.factory.declineApprovalRequest(
          ctx.userId,
          input.projectId,
          input.requestId,
        ),
      ),
    ),
  // The queue (change factory-manual-queue). Sending starts threads in the
  // caller's name, like saving: `steer`. A waiting issue is cancelled with
  // `stopRun`.
  submitIssues: projectProcedure('steer', SEND_FORBIDDEN)
    .input(submitFactoryIssuesInput)
    .mutation(async ({ ctx, input: { projectId, ...data } }) =>
      unwrap(await ctx.ports.factory.submitIssues(ctx.userId, projectId, data)),
    ),
  flows: projectProcedure('view')
    .input(factoryProjectInput)
    .query(async ({ ctx, input }) =>
      unwrap(await ctx.ports.factory.flows(ctx.userId, input.projectId)),
    ),
  flowDefinition: projectProcedure('view')
    .input(factoryFlowInput)
    .query(async ({ ctx, input }) =>
      unwrap(await ctx.ports.factory.flowDefinition(ctx.userId, input.projectId, input.flowName)),
    ),
  // How the repository merges through the merge queue (openspec factory-integration D12).
  readiness: projectProcedure('view')
    .input(factoryProjectInput)
    .query(async ({ ctx, input }) =>
      unwrap(await ctx.ports.factory.readiness(ctx.userId, input.projectId)),
    ),
  // Open the issue that adds CI on the queue's branches, run by the caller's factory (D12).
  proposeQueueCi: projectProcedure('steer', SEND_FORBIDDEN)
    .input(factoryProjectInput)
    .mutation(async ({ ctx, input }) =>
      unwrap(await ctx.ports.factory.proposeQueueCi(ctx.userId, input.projectId)),
    ),
  validateFlow: projectProcedure('view')
    .input(factoryFlowInput)
    .query(async ({ ctx, input }) =>
      unwrap(await ctx.ports.factory.validateFlow(ctx.userId, input.projectId, input.flowName)),
    ),
  blockers: projectProcedure('view')
    .input(factoryBlockersInput)
    .query(async ({ ctx, input }) =>
      unwrap(await ctx.ports.factory.blockers(ctx.userId, input.projectId, input.issueNumbers)),
    ),
  clearQueue: projectProcedure('steer', CONTROL_FORBIDDEN)
    .input(factoryProjectInput)
    .mutation(async ({ ctx, input }) =>
      unwrap(await ctx.ports.factory.clearQueue(ctx.userId, input.projectId)),
    ),
  stopAll: projectProcedure('steer', CONTROL_FORBIDDEN)
    .input(factoryProjectInput)
    .mutation(async ({ ctx, input }) =>
      unwrap(await ctx.ports.factory.stopAll(ctx.userId, input.projectId)),
    ),
  // Triggers (change flow-triggers). A trigger starts threads in the caller's
  // name at each occurrence, like sending an issue: `steer`.
  triggers: projectProcedure('view')
    .input(factoryProjectInput)
    .query(async ({ ctx, input }) =>
      unwrap(await ctx.ports.factory.triggers(ctx.userId, input.projectId)),
    ),
  saveTrigger: projectProcedure('steer', TRIGGER_FORBIDDEN)
    .input(saveFactoryTriggerInput)
    .mutation(async ({ ctx, input: { projectId, ...data } }) =>
      unwrap(await ctx.ports.factory.saveTrigger(ctx.userId, projectId, data)),
    ),
  removeTrigger: projectProcedure('steer', TRIGGER_FORBIDDEN)
    .input(factoryTriggerInput)
    .mutation(async ({ ctx, input }) =>
      unwrap(await ctx.ports.factory.removeTrigger(ctx.userId, input.projectId, input.triggerId)),
    ),
  issuelessFlow: projectProcedure('view')
    .input(factoryFlowInput)
    .query(async ({ ctx, input }) =>
      unwrap(await ctx.ports.factory.issuelessFlow(ctx.userId, input.projectId, input.flowName)),
    ),
  runFlow: projectProcedure('steer', RUN_FORBIDDEN)
    .input(runFactoryFlowInput)
    .mutation(async ({ ctx, input: { projectId, ...data } }) =>
      unwrap(await ctx.ports.factory.runFlow(ctx.userId, projectId, data)),
    ),
  /** Close the incident pausing the caller's factory; its admissions resume. */
  closeIncident: projectProcedure('steer', CONTROL_FORBIDDEN)
    .input(factoryProjectInput)
    .mutation(async ({ ctx, input }) =>
      unwrap(await ctx.ports.factory.closeIncident(ctx.userId, input.projectId)),
    ),
});
