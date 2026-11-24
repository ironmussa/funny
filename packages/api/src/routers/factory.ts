import {
  factoryBlockersInput,
  factoryFlowInput,
  factoryProjectInput,
  factoryRunInput,
  saveFactorySettingsInput,
  submitFactoryIssuesInput,
} from '@funny/shared/contracts/factory';

import { unwrap } from '../failure.js';
import { projectProcedure, protectedProcedure, router } from '../trpc.js';

const SAVE_FORBIDDEN = 'Running an issue factory needs contributor access to the project';
const CONTROL_FORBIDDEN = 'Controlling factory runs needs contributor access to the project';
const SEND_FORBIDDEN = 'Sending issues to a factory needs contributor access to the project';

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
    .input(factoryRunInput)
    .mutation(async ({ ctx, input }) =>
      unwrap(await ctx.ports.factory.approveMerge(ctx.userId, input.projectId, input.runId)),
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
  /** Close the incident pausing the caller's factory; its admissions resume. */
  closeIncident: projectProcedure('steer', CONTROL_FORBIDDEN)
    .input(factoryProjectInput)
    .mutation(async ({ ctx, input }) =>
      unwrap(await ctx.ports.factory.closeIncident(ctx.userId, input.projectId)),
    ),
});
