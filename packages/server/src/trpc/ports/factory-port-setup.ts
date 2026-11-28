/**
 * The `factory` tRPC port's flow setup methods (openspec `factory-flow-bootstrap`,
 * Task 4.7): converts `FactoryFlowSetupRow` → `FactoryFlowSetupView` and maps
 * `FlowSetupError` → `ApiFailure`.
 */

import { failure, type ApiFailure, type FactoryPort } from '@funny/api';
import type { FactoryFlowSetupFacts, FactoryFlowSetupView } from '@funny/shared/contracts/factory';
import type { FactoryFlowSetupRow } from '@funny/shared/repositories';
import { err, ok } from 'neverthrow';

import { getLiveFactoryFlowSetupService } from '../../services/factory/factory-flow-setup-live.js';
import {
  parseSetupColumn,
  storedFactsSchema,
  storedPromptFilesSchema,
  storedVerdictsSchema,
  type StoredSetupFacts,
} from '../../services/factory/factory-flow-setup-schemas.js';
import type {
  FactoryFlowSetupService,
  FlowSetupError,
} from '../../services/factory/factory-flow-setup.js';

/** The stored detection facts as the browser shows them. */
function toViewFacts(stored: StoredSetupFacts | null): FactoryFlowSetupFacts | null {
  if (!stored) return null;
  if (!('packages' in stored)) return { recognized: false, error: stored.error };
  return {
    recognized: stored.recognized,
    packageManager: stored.packageManager,
    packages: stored.packages.map((pkg) => ({
      name: pkg.name,
      dir: pkg.root,
      runner: pkg.runner ?? 'unknown',
      configFiles: pkg.configFile ? [pkg.configFile] : [],
      testPatterns: pkg.testPatterns,
    })),
    infraFiles: stored.infrastructureTests.map((test) => test.path),
  };
}

export function toFlowSetupView(row: FactoryFlowSetupRow): FactoryFlowSetupView {
  return {
    id: row.id,
    projectId: row.projectId,
    flowName: row.flowName,
    defaultBranch: row.defaultBranch,
    baseSha: row.baseSha,
    threadId: row.threadId,
    branch: row.branch,
    state: row.state,
    startingFile: row.startingFile,
    startingSource: row.startingSource === 'repo' ? 'repo' : 'builtin',
    builtinPrompts:
      parseSetupColumn(storedPromptFilesSchema, row.builtinPrompts, 'builtin_prompts') ?? [],
    proposedFile: row.proposedFile,
    proposedFileSha: row.proposedFileSha,
    commitVariant:
      row.commitVariant === 'rules' || row.commitVariant === 'opt-out' ? row.commitVariant : null,
    facts: toViewFacts(parseSetupColumn(storedFactsSchema, row.facts, 'facts')),
    verdicts: parseSetupColumn(storedVerdictsSchema, row.verdicts, 'verdicts'),
    error: row.error,
    commitSha: row.commitSha,
    prNumber: row.prNumber,
    prUrl: row.prUrl,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    endedAt: row.endedAt,
  };
}

function flowSetupFailure(error: FlowSetupError): ApiFailure {
  return {
    status: error.status,
    message: error.message,
    friendlyMessage: error.message,
    code: error.kind,
  };
}

type SetupPortMethods = Pick<
  FactoryPort,
  | 'startFlowSetup'
  | 'flowSetup'
  | 'confirmFlowSetup'
  | 'openFlowSetupPullRequest'
  | 'discardFlowSetup'
>;

export function setupPortMethods(
  getService: () => FactoryFlowSetupService = getLiveFactoryFlowSetupService,
): SetupPortMethods {
  return {
    async startFlowSetup(userId, projectId, flowName) {
      try {
        const res = await getService().startFlowSetup({ userId }, projectId, flowName);
        return res.isOk() ? ok(toFlowSetupView(res.value)) : err(flowSetupFailure(res.error));
      } catch (cause) {
        return err(failure(500, cause instanceof Error ? cause.message : String(cause)));
      }
    },

    async flowSetup(userId, projectId, flowName) {
      try {
        const row = await getService().getFlowSetup({ userId }, projectId, flowName);
        return ok(row ? toFlowSetupView(row) : null);
      } catch (cause) {
        return err(failure(500, cause instanceof Error ? cause.message : String(cause)));
      }
    },

    async confirmFlowSetup(userId, _projectId, setupId, fileSha, variant) {
      try {
        const res = await getService().confirmFlowSetup({ userId }, setupId, fileSha, variant);
        return res.isOk() ? ok(toFlowSetupView(res.value)) : err(flowSetupFailure(res.error));
      } catch (cause) {
        return err(failure(500, cause instanceof Error ? cause.message : String(cause)));
      }
    },

    async openFlowSetupPullRequest(userId, _projectId, setupId) {
      try {
        const res = await getService().openFlowSetupPullRequest({ userId }, setupId);
        return res.isOk() ? ok(toFlowSetupView(res.value)) : err(flowSetupFailure(res.error));
      } catch (cause) {
        return err(failure(500, cause instanceof Error ? cause.message : String(cause)));
      }
    },

    async discardFlowSetup(userId, _projectId, setupId) {
      try {
        const res = await getService().discardFlowSetup({ userId }, setupId);
        return res.isOk() ? ok(toFlowSetupView(res.value)) : err(flowSetupFailure(res.error));
      } catch (cause) {
        return err(failure(500, cause instanceof Error ? cause.message : String(cause)));
      }
    },
  };
}
