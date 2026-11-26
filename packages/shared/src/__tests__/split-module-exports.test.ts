/**
 * The four modules split by #542 (types.ts, remote-connector-protocol.ts,
 * db/schema.sqlite.ts, repositories/message-repository.ts) re-export what
 * moved into their sub-modules. These lists pin the runtime exports of each
 * entry point, so a missed re-export (or an internal helper that leaks out)
 * fails here instead of in a consumer's build. The lint test keeps the
 * modules (and the files they were split into) under the size rules.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import * as schemaSqlite from '../db/schema.sqlite.js';
import * as remoteConnectorProtocol from '../remote-connector-protocol.js';
import { createMessageRepository } from '../repositories/message-repository.js';
import * as types from '../types.js';
import { createTestDb } from './helpers/test-db.js';

describe('split shared entry points keep their exports', () => {
  test('@funny/shared (types.ts)', () => {
    expect(Object.keys(types).sort()).toEqual([
      'AUTO_RESUME_MESSAGE_AUTHOR',
      'BUILTIN_AGENT_TEMPLATES',
      'DEEPAGENT_TOOLS',
      'DEFAULT_PROVIDER_RESOURCE_DESCRIPTOR',
      'FILE_MUTATING_TOOLS',
      'HOOK_TYPES',
      'PROVIDER_RESOURCE_DESCRIPTORS',
      'REMOTE_CONNECTOR_APPROVAL_SIGNATURE_DOMAIN',
      'REMOTE_CONNECTOR_ENROLMENT_TTL_MS',
      'REMOTE_CONNECTOR_MAX_CLOCK_SKEW_MS',
      'REMOTE_CONNECTOR_MAX_OUTPUT_BYTES',
      'REMOTE_CONNECTOR_MAX_REQUEST_AGE_MS',
      'REMOTE_CONNECTOR_MAX_REQUEST_LIFETIME_MS',
      'REMOTE_CONNECTOR_PAIRING_TTL_MS',
      'REMOTE_CONNECTOR_PROTOCOL_VERSION',
      'REMOTE_CONNECTOR_PROTOCOL_VERSIONS',
      'REMOTE_CONNECTOR_REQUEST_SIGNATURE_DOMAIN',
      'REMOTE_CONNECTOR_SIGNATURE_ALGORITHM',
      'REMOTE_CONNECTOR_TARGET_CONFIG_MAX_LIFETIME_MS',
      'REMOTE_CONNECTOR_TARGET_SIGNATURE_DOMAIN',
      'agentExecutionProfileConfigSchema',
      'agentExecutionProfileProviderSchema',
      'assertEnvelopeBinding',
      'buildAgentExecutionProfileEnv',
      'canonicalJson',
      'claudeExecutionProfileConfigSchema',
      'collectSessionChanges',
      'connectorCapabilities',
      'connectorCapabilitySchema',
      'connectorErrorCodeSchema',
      'connectorErrorCodes',
      'connectorErrorResultSchema',
      'connectorHealthRequestSchema',
      'connectorHealthResultSchema',
      'connectorHelloSchema',
      'connectorIpcRequestSchema',
      'connectorIpcResponseSchema',
      'connectorNegotiationRequestSchema',
      'connectorNegotiationResultSchema',
      'connectorPairingConfirmationSchema',
      'connectorPairingRegistrationSchema',
      'createAgentExecutionProfileSchema',
      'createRemoteExecutionDigest',
      'createTargetConfigDigest',
      'credentialEnrolmentEnvelopeSchema',
      'credentialEnvelopeAdditionalData',
      'credentialEnvelopeBindingSchema',
      'credentialMutationAcknowledgementSchema',
      'credentialMutationSchema',
      'getProviderResourceDescriptor',
      'isErrorDiagnostic',
      'latestSessionChanges',
      'negotiateConnectorProtocol',
      'relativizePath',
      'remoteArgumentDefinitionSchema',
      'remoteArgumentValueSchema',
      'remoteCancellationSchema',
      'remoteCommandTokenSchema',
      'remoteExecutionActorSchema',
      'remoteExecutionAuditSchema',
      'remoteExecutionDigestPayloadSchema',
      'remoteExecutionRequestSchema',
      'remoteExecutionResultSchema',
      'remoteExecutionSignaturePayload',
      'remoteOperationSchema',
      'remoteProductionApprovalSchema',
      'remoteProductionApprovalSignaturePayload',
      'remoteTargetConfigSchema',
      'resourceUsableByProvider',
      'sha256Digest',
      'signedTargetConfigSchema',
      'targetConfigAcknowledgementSchema',
      'targetConfigSignaturePayload',
      'targetConfigUpdateSchema',
      'threadBrowserSessionId',
      'threadIdFromBrowserSessionId',
      'toAgentExecutionProfileResponse',
      'toolCallFilePath',
      'unsignedRemoteExecutionRequestSchema',
      'updateAgentExecutionProfileSchema',
      'updateProjectAgentProfileBindingSchema',
      'validateRemoteExecutionAgainstTarget',
      'validateRemoteOperationArguments',
      'validateSignedTargetConfigEnvelope',
    ]);
  });

  test('@funny/shared/remote-connector-protocol', () => {
    expect(Object.keys(remoteConnectorProtocol).sort()).toEqual([
      'REMOTE_CONNECTOR_APPROVAL_SIGNATURE_DOMAIN',
      'REMOTE_CONNECTOR_ENROLMENT_TTL_MS',
      'REMOTE_CONNECTOR_MAX_CLOCK_SKEW_MS',
      'REMOTE_CONNECTOR_MAX_OUTPUT_BYTES',
      'REMOTE_CONNECTOR_MAX_REQUEST_AGE_MS',
      'REMOTE_CONNECTOR_MAX_REQUEST_LIFETIME_MS',
      'REMOTE_CONNECTOR_PAIRING_TTL_MS',
      'REMOTE_CONNECTOR_PROTOCOL_VERSION',
      'REMOTE_CONNECTOR_PROTOCOL_VERSIONS',
      'REMOTE_CONNECTOR_REQUEST_SIGNATURE_DOMAIN',
      'REMOTE_CONNECTOR_SIGNATURE_ALGORITHM',
      'REMOTE_CONNECTOR_TARGET_CONFIG_MAX_LIFETIME_MS',
      'REMOTE_CONNECTOR_TARGET_SIGNATURE_DOMAIN',
      'assertEnvelopeBinding',
      'canonicalJson',
      'connectorCapabilities',
      'connectorCapabilitySchema',
      'connectorCapabilityTokenSchema',
      'connectorErrorCodeSchema',
      'connectorErrorCodes',
      'connectorErrorResultSchema',
      'connectorHealthRequestSchema',
      'connectorHealthResultSchema',
      'connectorHelloSchema',
      'connectorIpcRequestSchema',
      'connectorIpcResponseSchema',
      'connectorNegotiationRequestSchema',
      'connectorNegotiationResultSchema',
      'connectorPairingConfirmationRequestSchema',
      'connectorPairingConfirmationResultSchema',
      'connectorPairingConfirmationSchema',
      'connectorPairingRegistrationSchema',
      'connectorPairingStatusRequestSchema',
      'connectorPairingStatusResultSchema',
      'createConnectorPairingCodeHash',
      'createRemoteExecutionDigest',
      'createTargetConfigDigest',
      'credentialEnrolmentEnvelopeSchema',
      'credentialEnvelopeAdditionalData',
      'credentialEnvelopeBindingSchema',
      'credentialMutationAcknowledgementSchema',
      'credentialMutationSchema',
      'negotiateConnectorProtocol',
      'remoteArgumentDefinitionSchema',
      'remoteArgumentValueSchema',
      'remoteCancellationSchema',
      'remoteCommandTokenSchema',
      'remoteExecutionActorSchema',
      'remoteExecutionAuditSchema',
      'remoteExecutionDigestPayloadSchema',
      'remoteExecutionRequestSchema',
      'remoteExecutionResultSchema',
      'remoteExecutionSignaturePayload',
      'remoteOperationSchema',
      'remoteProductionApprovalSchema',
      'remoteProductionApprovalSignaturePayload',
      'remoteTargetConfigSchema',
      'sha256Digest',
      'signedTargetConfigSchema',
      'targetConfigAcknowledgementSchema',
      'targetConfigSignaturePayload',
      'targetConfigUpdateSchema',
      'unsignedRemoteExecutionRequestSchema',
      'validateRemoteExecutionAgainstTarget',
      'validateRemoteOperationArguments',
      'validateSignedTargetConfigEnvelope',
    ]);
  });

  test('@funny/shared/db/schema-sqlite', () => {
    expect(Object.keys(schemaSqlite).sort()).toEqual([
      'account',
      'activities',
      'agentExecutionProfiles',
      'agentTemplates',
      'automationRuns',
      'automations',
      'designs',
      'factoryApprovalRequests',
      'factoryBatchAttempts',
      'factoryBatches',
      'factoryIncidents',
      'factoryRuns',
      'factorySettings',
      'factoryTriggers',
      'infraConnections',
      'instanceSettings',
      'invitation',
      'inviteLinks',
      'jobs',
      'mcpOauthTokens',
      'member',
      'messageQueue',
      'messages',
      'organization',
      'pendingPermissionRequests',
      'permissionRules',
      'personalAccessTokens',
      'pipelineRuns',
      'pipelines',
      'projectAgentProfileBindings',
      'projectMemberConfig',
      'projectMembers',
      'projectRunnerGrants',
      'projectRunnerSettings',
      'projectSandboxSettings',
      'projectSecrets',
      'projects',
      'pushSubscriptions',
      'resourceGrants',
      'runnerEnrollments',
      'runnerEventReceipts',
      'runnerOperationIdempotency',
      'runnerPolicyVersion',
      'runnerProjectAssignments',
      'runnerProvisionTokens',
      'runnerTasks',
      'runners',
      'session',
      'stageHistory',
      'startupCommands',
      'teamProjects',
      'threadComments',
      'threadEvents',
      'threadSandboxes',
      'threadSessions',
      'threadShares',
      'threads',
      'toolCalls',
      'user',
      'userProfiles',
      'verification',
      'watchers',
      'workflowConcurrencyLeases',
      'workflowConcurrencyWaiters',
      'workflowNodeExecutions',
    ]);
  });

  test('createMessageRepository returns the same methods', () => {
    const repo = createMessageRepository(createTestDb());
    expect(Object.keys(repo).sort()).toEqual([
      'deleteMessagesAfter',
      'enrichMessages',
      'getThreadMessages',
      'getThreadWithMessages',
      'insertMessage',
      'searchMessages',
      'updateMessage',
    ]);
    for (const method of Object.values(repo)) expect(typeof method).toBe('function');
  });
});

const ROOT = join(import.meta.dir, '..', '..', '..', '..');

/** First Bun with `bun lint` (as scripts/bun-lint.ts); CI's test jobs pin an older one. */
const HAS_BUN_LINT = Bun.semver.order(Bun.version, '1.4.6') >= 0;

const SPLIT_PATHS = [
  'packages/shared/src/types.ts',
  'packages/shared/src/types',
  'packages/shared/src/remote-connector-protocol.ts',
  'packages/shared/src/remote-connector-protocol',
  'packages/shared/src/db/schema.sqlite.ts',
  'packages/shared/src/db/schema-sqlite',
  'packages/shared/src/repositories/message-repository.ts',
  'packages/shared/src/repositories/message-repository',
];

describe('split shared modules stay under the size rules (#542)', () => {
  test.skipIf(!HAS_BUN_LINT)(
    'no eslint(max-lines) or eslint(max-lines-per-function) warning',
    () => {
      const run = Bun.spawnSync(
        [
          process.execPath,
          join(ROOT, 'scripts', 'bun-lint.ts'),
          '--format',
          'agent',
          ...SPLIT_PATHS,
        ],
        { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' },
      );
      const out = `${run.stdout.toString()}${run.stderr.toString()}`;
      // A non-zero exit with no diagnostic means the linter did not run.
      const linted = /^\S+:\d+:\d+: (warning|error) /m.test(out);
      if (run.exitCode !== 0 && !linted) throw new Error(`bun lint failed:\n${out.slice(0, 2000)}`);
      const sizeWarnings = out
        .split('\n')
        .filter((line) => /eslint\(max-lines(-per-function)?\)/.test(line));
      expect(sizeWarnings).toEqual([]);
    },
    120_000,
  );
});
