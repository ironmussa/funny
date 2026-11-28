/**
 * The caller's own issue factory for a project (change issue-factory), for the
 * `factory` tRPC router. The procedure checked the project capability; the
 * settings service re-checks it and scopes every row to the caller. Saving
 * reschedules the server's watcher, so an enable or disable applies at once.
 */

import { type ApiFailure, type FactoryPort } from '@funny/api';
import { ResultAsync } from 'neverthrow';

import {
  factoryAgentToolsWith,
  type AgentRunControl,
} from '../../services/factory/factory-agent-tools.js';
import { createFactoryApprovalRequestsRepository } from '../../services/factory/factory-approval-requests.js';
import { createFactoryIncidentsRepository } from '../../services/factory/factory-incidents.js';
import { createFactoryQueue } from '../../services/factory/factory-queue.js';
import { createFactoryRunControl } from '../../services/factory/factory-run-control.js';
import {
  createFactoryRunsRepository,
  type FactoryRunView,
} from '../../services/factory/factory-runs.js';
import { createFactorySettingsService } from '../../services/factory/factory-settings.js';
import { lanePortMethods } from './factory-port-lanes.js';
import { queuePortMethods } from './factory-port-queue.js';
import { createRunControl, runPortMethods } from './factory-port-runs.js';
import { setupPortMethods } from './factory-port-setup.js';
import { factoryScope, type FactoryPortDeps } from './factory-port-shared.js';

/** The factory port, and the run controls an agent may use. */
interface FactoryParts {
  port: FactoryPort;
  controlled: ControlRun;
}

function createFactoryParts(
  runs = createFactoryRunsRepository(),
  control = createFactoryRunControl(runs),
  queue = createFactoryQueue({ runs, control }),
  settings = createFactorySettingsService({
    validateFlow: (factoryId, projectId, flowName, options) =>
      queue.validateFlow(factoryId, projectId, flowName, options),
  }),
  incidents = createFactoryIncidentsRepository(),
  requests = createFactoryApprovalRequestsRepository(),
): FactoryParts {
  const deps: FactoryPortDeps = { settings, runs, control, queue, incidents, requests };
  const scope = factoryScope(deps);
  const controlled = createRunControl(deps, scope);
  const port: FactoryPort = {
    ...runPortMethods(deps, scope, controlled),
    ...queuePortMethods(deps, scope),
    ...lanePortMethods(deps),
    ...setupPortMethods(),
  };

  return {
    port,
    // The controls an agent has. The action type leaves `approve-merge` and `split` out.
    controlled: (action, userId, projectId, runId, askedByThread, reason) =>
      controlled(action, userId, projectId, runId, { askedByThread, reason }),
  };
}

type ControlRun = (
  action: AgentRunControl,
  userId: string,
  projectId: string,
  runId: string,
  askedByThread: string,
  reason?: string,
) => ResultAsync<FactoryRunView, ApiFailure>;

const parts = createFactoryParts();

export const factoryPort = parts.port;

/** The factory tools of the `funny` MCP server, behind the runner's data channel. */
export const factoryAgentTools = factoryAgentToolsWith(parts.controlled);
