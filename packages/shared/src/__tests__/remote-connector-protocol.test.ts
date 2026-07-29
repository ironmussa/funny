import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  assertEnvelopeBinding,
  connectorHealthResultSchema,
  connectorNegotiationRequestSchema,
  connectorNegotiationResultSchema,
  connectorPairingConfirmationSchema,
  connectorPairingRegistrationSchema,
  connectorPairingStatusResultSchema,
  createRemoteExecutionDigest,
  createTargetConfigDigest,
  credentialEnrolmentEnvelopeSchema,
  credentialMutationAcknowledgementSchema,
  negotiateConnectorProtocol,
  remoteExecutionAuditSchema,
  remoteExecutionRequestSchema,
  remoteExecutionResultSchema,
  remoteExecutionSignaturePayload,
  remoteProductionApprovalSignaturePayload,
  remoteTargetConfigSchema,
  targetConfigAcknowledgementSchema,
  targetConfigUpdateSchema,
  validateRemoteExecutionAgainstTarget,
  validateRemoteOperationArguments,
  validateSignedTargetConfigEnvelope,
  type ConnectorHello,
  type ConnectorNegotiationRequest,
  type CredentialEnrolmentEnvelope,
  type RemoteOperation,
  type UnsignedRemoteExecutionRequest,
} from '../remote-connector-protocol';

const timestamp = '2026-07-23T12:00:00.000Z';
const laterTimestamp = '2026-07-23T12:01:00.000Z';
const requestNow = Date.parse(timestamp) + 30_000;
const digest = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const fingerprint = `SHA256:${digest}`;

const unsignedRequest: UnsignedRemoteExecutionRequest = {
  kind: 'execute',
  protocolVersion: 1,
  requestId: 'request-1',
  runnerId: 'runner-1',
  connectorId: 'connector-1',
  projectId: 'project-1',
  threadId: 'thread-1',
  targetId: 'target-1',
  operationId: 'status',
  arguments: {},
  actor: { userId: 'user-1', kind: 'human' },
  issuedAt: timestamp,
  expiresAt: laterTimestamp,
  nonce: digest,
};

const operation: RemoteOperation = {
  id: 'logs',
  name: 'Read logs',
  executable: '/usr/bin/journalctl',
  argv: [{ literal: '--lines' }, { argument: 'lines' }],
  arguments: {
    lines: { type: 'integer', required: true, minimum: 1, maximum: 100 },
  },
  timeoutMs: 30_000,
  outputLimitBytes: 16_384,
};

const target = {
  protocolVersion: 1 as const,
  targetId: 'target-1',
  configVersion: 1,
  runnerId: 'runner-1',
  connectorId: 'connector-1',
  name: 'API staging',
  environment: 'staging' as const,
  enabled: true,
  host: 'staging.internal',
  port: 22,
  username: 'deploy',
  hostKeyFingerprints: [fingerprint],
  credentialRef: 'credential-1',
  credentialVersion: 1,
  connectTimeoutMs: 10_000,
  operations: [operation],
};

describe('remote Connector protocol', () => {
  test('standard execution requests reject credential and SSH connection fields', async () => {
    const requestDigest = await createRemoteExecutionDigest(unsignedRequest);
    const valid = {
      ...unsignedRequest,
      requestDigest,
      signature: digest,
    };
    expect(remoteExecutionRequestSchema.parse(valid).targetId).toBe('target-1');

    for (const unsafe of [
      { password: 'do-not-store' },
      { privateKey: 'do-not-store' },
      { host: 'attacker.invalid' },
      { port: 2222 },
      { username: 'root' },
      { command: 'rm -rf data' },
      { credentialRef: 'credential-other' },
    ]) {
      expect(remoteExecutionRequestSchema.safeParse({ ...valid, ...unsafe }).success).toBe(false);
    }
  });

  test('metadata-only audits reject credentials, commands, connection data, and output', () => {
    const audit = {
      auditId: 'audit-1',
      requestId: 'request-1',
      requestDigest: digest,
      actorId: 'user-1',
      actorKind: 'human',
      projectId: 'project-1',
      threadId: null,
      runnerId: 'runner-1',
      connectorId: 'connector-1',
      targetId: 'target-1',
      operationId: 'status',
      connectorKeyVersion: 1,
      authorization: 'allowed',
      approval: 'not-required',
      status: 'succeeded',
      createdAt: timestamp,
    };
    expect(remoteExecutionAuditSchema.safeParse(audit).success).toBe(true);
    expect(remoteExecutionAuditSchema.safeParse({ ...audit, password: 'secret' }).success).toBe(
      false,
    );
    expect(remoteExecutionAuditSchema.safeParse({ ...audit, host: 'server' }).success).toBe(false);
    expect(remoteExecutionAuditSchema.safeParse({ ...audit, argv: ['status'] }).success).toBe(
      false,
    );
    expect(remoteExecutionAuditSchema.safeParse({ ...audit, stdout: 'output' }).success).toBe(
      false,
    );
  });

  test('enrolment envelopes are bound to one connector, runner, target, key, and version', () => {
    const envelope: CredentialEnrolmentEnvelope = {
      kind: 'credential-enrolment',
      algorithm: 'RSA-OAEP-256+A256GCM',
      binding: {
        protocolVersion: 1,
        connectorId: 'connector-1',
        runnerId: 'runner-1',
        connectorKeyVersion: 2,
        targetId: 'target-1',
        credentialVersion: 3,
        expiresAt: laterTimestamp,
      },
      wrappedKey: digest,
      iv: digest,
      ciphertext: digest,
    };
    expect(credentialEnrolmentEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(() => assertEnvelopeBinding(envelope, envelope.binding, requestNow)).not.toThrow();
    for (const mismatchedBinding of [
      { ...envelope.binding, connectorId: 'connector-2' },
      { ...envelope.binding, runnerId: 'runner-2' },
      { ...envelope.binding, connectorKeyVersion: 3 },
      { ...envelope.binding, targetId: 'target-2' },
      { ...envelope.binding, credentialVersion: 4 },
    ]) {
      expect(() => assertEnvelopeBinding(envelope, mismatchedBinding)).toThrow('binding mismatch');
    }
    expect(
      credentialEnrolmentEnvelopeSchema.safeParse({
        ...envelope,
        binding: { ...envelope.binding, protocolVersion: 2 },
      }).success,
    ).toBe(false);
    expect(() =>
      assertEnvelopeBinding(envelope, envelope.binding, Date.parse(laterTimestamp)),
    ).toThrow('expired');
    expect(() =>
      assertEnvelopeBinding(
        {
          ...envelope,
          binding: {
            ...envelope.binding,
            expiresAt: '2026-07-23T12:06:00.001Z',
          },
        },
        {
          ...envelope.binding,
          expiresAt: '2026-07-23T12:06:00.001Z',
        },
        Date.parse(timestamp),
      ),
    ).toThrow('lifetime exceeds policy');

    const acknowledgement = {
      kind: 'credential-ack',
      protocolVersion: 1,
      connectorId: envelope.binding.connectorId,
      targetId: envelope.binding.targetId,
      credentialVersion: envelope.binding.credentialVersion,
      status: 'stored',
    };
    expect(credentialMutationAcknowledgementSchema.safeParse(acknowledgement).success).toBe(true);
    expect(
      credentialMutationAcknowledgementSchema.safeParse({
        ...acknowledgement,
        password: 'must-never-return',
      }).success,
    ).toBe(false);
    expect(
      credentialMutationAcknowledgementSchema.safeParse({
        ...acknowledgement,
        status: 'rejected',
        errorCode: 'ENROLMENT_REJECTED',
      }).success,
    ).toBe(true);
  });

  test('execution results enforce output limits in encoded bytes', () => {
    const result = {
      kind: 'result',
      protocolVersion: 1,
      requestId: 'request-1',
      status: 'succeeded',
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      startedAt: timestamp,
      completedAt: laterTimestamp,
    };
    expect(remoteExecutionResultSchema.safeParse(result).success).toBe(true);
    expect(
      remoteExecutionResultSchema.safeParse({
        ...result,
        stdout: '€'.repeat(100_000),
      }).success,
    ).toBe(false);
  });

  test('targets reject duplicate/unknown operations and unsafe request arguments', () => {
    expect(remoteTargetConfigSchema.safeParse(target).success).toBe(true);
    expect(() => validateRemoteOperationArguments(operation, { lines: 20 })).not.toThrow();
    expect(() => validateRemoteOperationArguments(operation, { lines: 101 })).toThrow();
    expect(() => validateRemoteOperationArguments(operation, { shell: 'whoami' })).toThrow(
      'Unknown',
    );
    expect(
      remoteTargetConfigSchema.safeParse({
        ...target,
        operations: [operation, operation],
      }).success,
    ).toBe(false);
    expect(
      remoteTargetConfigSchema.safeParse({
        ...target,
        operations: [
          {
            ...operation,
            arguments: {
              value: { type: 'string', required: true, pattern: '[' },
            },
          },
        ],
      }).success,
    ).toBe(false);
  });

  test('signed target updates bind a monotonic version, digest, authority, and lifetime', async () => {
    const configDigest = await createTargetConfigDigest(target);
    const signedTarget = {
      config: target,
      issuedAt: timestamp,
      expiresAt: '2026-08-01T12:00:00.000Z',
      configDigest,
      signatureAlgorithm: 'Ed25519' as const,
      authorityKeyFingerprint: fingerprint,
      signature: digest,
    };
    expect(
      targetConfigUpdateSchema.safeParse({
        kind: 'target-config-update',
        protocolVersion: 1,
        signedTarget,
      }).success,
    ).toBe(true);
    await expect(
      validateSignedTargetConfigEnvelope(signedTarget, requestNow),
    ).resolves.toMatchObject({
      config: { targetId: 'target-1', configVersion: 1 },
    });
    await expect(
      validateSignedTargetConfigEnvelope(
        { ...signedTarget, configDigest: `${configDigest}x` },
        requestNow,
      ),
    ).rejects.toThrow('digest mismatch');
    await expect(
      validateSignedTargetConfigEnvelope(
        { ...signedTarget, expiresAt: '2026-08-23T12:00:00.001Z' },
        requestNow,
      ),
    ).rejects.toThrow('lifetime exceeds policy');

    const acknowledgement = {
      kind: 'target-config-ack',
      protocolVersion: 1,
      connectorId: target.connectorId,
      targetId: target.targetId,
      configVersion: target.configVersion,
      configDigest,
      status: 'cached',
    };
    expect(targetConfigAcknowledgementSchema.safeParse(acknowledgement).success).toBe(true);
    expect(
      targetConfigAcknowledgementSchema.safeParse({
        ...acknowledgement,
        credentialRef: target.credentialRef,
      }).success,
    ).toBe(false);
  });

  test('execution validation rejects unknown operations, invalid arguments, and target bindings', async () => {
    const base = {
      ...unsignedRequest,
      operationId: 'logs',
      arguments: { lines: 20 },
    };
    const valid = {
      ...base,
      requestDigest: await createRemoteExecutionDigest(base),
      signature: digest,
    };
    await expect(
      validateRemoteExecutionAgainstTarget(valid, target, requestNow),
    ).resolves.toMatchObject({
      operation: { id: 'logs' },
      arguments: { lines: 20 },
    });

    for (const invalid of [
      { ...base, operationId: 'missing' },
      { ...base, arguments: { lines: 101 } },
      { ...base, runnerId: 'runner-2' },
      { ...base, connectorId: 'connector-2' },
      { ...base, targetId: 'target-2' },
    ]) {
      await expect(
        validateRemoteExecutionAgainstTarget(
          {
            ...invalid,
            requestDigest: await createRemoteExecutionDigest(invalid),
            signature: digest,
          },
          target,
          requestNow,
        ),
      ).rejects.toThrow();
    }
  });

  test('production approval is bound to the request digest without a circular digest', async () => {
    const productionTarget = { ...target, environment: 'production' as const };
    const base = {
      ...unsignedRequest,
      operationId: 'logs',
      arguments: { lines: 20 },
    };
    const requestDigest = await createRemoteExecutionDigest(base);
    const approval = {
      approvalId: 'approval-1',
      requestDigest,
      approvedBy: 'user-2',
      issuedAt: timestamp,
      expiresAt: laterTimestamp,
      nonce: digest,
      signature: digest,
    };
    const request = {
      ...base,
      approval,
      requestDigest: await createRemoteExecutionDigest({ ...base, approval }),
      signature: digest,
    };

    expect(request.requestDigest).toBe(requestDigest);
    await expect(
      validateRemoteExecutionAgainstTarget(request, productionTarget, requestNow),
    ).resolves.toMatchObject({ operation: { id: 'logs' } });
    await expect(
      validateRemoteExecutionAgainstTarget(
        { ...request, approval: { ...approval, requestDigest: `${requestDigest}x` } },
        productionTarget,
        requestNow,
      ),
    ).rejects.toThrow('approval digest mismatch');

    const overlong = {
      ...base,
      expiresAt: '2026-07-23T12:02:00.001Z',
    };
    await expect(
      validateRemoteExecutionAgainstTarget(
        {
          ...overlong,
          requestDigest: await createRemoteExecutionDigest(overlong),
          signature: digest,
        },
        target,
        requestNow,
      ),
    ).rejects.toThrow('lifetime exceeds policy');
  });

  test('request and approval signature payloads use separate deterministic domains', async () => {
    const base = {
      ...unsignedRequest,
      operationId: 'logs',
      arguments: { lines: 20 },
    };
    const requestDigest = await createRemoteExecutionDigest(base);
    expect(requestDigest).toBe('dw9IU6Mwh_Hh11MKtSGxvUj-_8EAMi2QEf8Kik12LCE');
    expect(new TextDecoder().decode(remoteExecutionSignaturePayload(requestDigest))).toBe(
      `funny-remote-connector-request-v1\0${requestDigest}`,
    );
    expect(
      new TextDecoder().decode(
        remoteProductionApprovalSignaturePayload({
          approvalId: 'approval-1',
          requestDigest,
          approvedBy: 'user-2',
          issuedAt: timestamp,
          expiresAt: laterTimestamp,
          nonce: digest,
        }),
      ),
    ).toBe(
      `funny-remote-connector-production-approval-v1\0${JSON.stringify({
        approvalId: 'approval-1',
        approvedBy: 'user-2',
        expiresAt: laterTimestamp,
        issuedAt: timestamp,
        nonce: digest,
        requestDigest,
      })}`,
    );
  });

  test('negotiation selects the local protocol and fails closed for incompatible peers', () => {
    const hello: ConnectorHello = {
      kind: 'hello',
      connectorId: 'connector-1',
      productVersion: '1.0.0',
      protocolVersions: [1],
      capabilities: ['credential-enrolment-v1', 'ssh-exec-v1'],
      platform: 'linux',
      architecture: 'x64',
      isolation: 'verified',
      keyVersion: 1,
      publicKey: digest,
      publicKeyFingerprint: fingerprint,
    };
    const request: ConnectorNegotiationRequest = {
      kind: 'negotiate',
      protocolVersions: [1],
      requiredCapabilities: ['ssh-exec-v1'],
      runtimeVersion: '1.0.0',
    };
    expect(negotiateConnectorProtocol(request, hello)).toMatchObject({ compatible: true });
    expect(negotiateConnectorProtocol(request, { ...hello, isolation: 'failed' })).toMatchObject({
      compatible: false,
      reason: 'isolation-unavailable',
    });
    expect(
      negotiateConnectorProtocol({ ...request, requiredCapabilities: ['password-auth-v1'] }, hello),
    ).toMatchObject({ compatible: false, reason: 'missing-capability' });
    expect(
      negotiateConnectorProtocol(request, hello, { revokedVersions: new Set(['1.0.0']) }),
    ).toMatchObject({ compatible: false, reason: 'revoked-connector' });
    expect(
      negotiateConnectorProtocol(
        request,
        { ...hello, productVersion: '0.9.0' },
        { minimumConnectorVersion: '1.0.0' },
      ),
    ).toMatchObject({ compatible: false, reason: 'peer-version-too-old' });
    expect(negotiateConnectorProtocol({ ...request, protocolVersions: [2] }, hello)).toMatchObject({
      compatible: false,
      reason: 'no-common-protocol',
    });
    expect(
      negotiateConnectorProtocol({ ...request, protocolVersions: [2, 1] }, hello),
    ).toMatchObject({ compatible: true, protocolVersion: 1 });
    expect(
      connectorNegotiationRequestSchema.safeParse({
        ...request,
        protocolVersions: [1, 1],
      }).success,
    ).toBe(false);
  });

  test('pairing and health expose only public Connector registration data', () => {
    const connector: ConnectorHello = {
      kind: 'hello',
      connectorId: 'connector-1',
      productVersion: '0.1.0',
      protocolVersions: [1],
      capabilities: ['credential-enrolment-v1', 'ssh-exec-v1'],
      platform: 'linux',
      architecture: 'x64',
      isolation: 'verified',
      keyVersion: 1,
      publicKey: digest,
      publicKeyFingerprint: fingerprint,
    };
    const registration = {
      connector,
      pairingCodeHash: digest,
      pairingExpiresAt: laterTimestamp,
    };
    expect(connectorPairingRegistrationSchema.safeParse(registration).success).toBe(true);
    expect(
      connectorPairingRegistrationSchema.safeParse({
        ...registration,
        pairingCode: 'ABCD-EFGH',
      }).success,
    ).toBe(false);
    expect(
      connectorPairingRegistrationSchema.safeParse({
        ...registration,
        privateKey: digest,
      }).success,
    ).toBe(false);
    expect(
      connectorPairingStatusResultSchema.safeParse({
        kind: 'pairing-status-result',
        protocolVersion: 1,
        registration,
        pairedRunnerId: null,
      }).success,
    ).toBe(true);
    expect(
      connectorHealthResultSchema.safeParse({
        kind: 'health-result',
        protocolVersion: 1,
        connector,
        status: 'healthy',
        pairedRunnerId: 'runner-1',
        providerStatus: 'unavailable',
      }).success,
    ).toBe(true);
    expect(
      connectorPairingConfirmationSchema.safeParse({
        connectorId: connector.connectorId,
        runnerId: 'runner-1',
        pairingCode: 'ABCD-EFGH',
        publicKeyFingerprint: connector.publicKeyFingerprint,
      }).success,
    ).toBe(true);
    expect(
      connectorPairingConfirmationSchema.safeParse({
        connectorId: connector.connectorId,
        runnerId: 'runner-1',
        pairingCode: 'already-consumed',
        publicKeyFingerprint: connector.publicKeyFingerprint,
      }).success,
    ).toBe(false);
  });

  test('canonical Connector fixtures conform to the shared schemas', () => {
    const fixtures = JSON.parse(
      readFileSync(
        join(import.meta.dir, '..', '__fixtures__', 'remote-connector-protocol-v1.json'),
        'utf8',
      ),
    ) as {
      negotiationRequests: unknown[];
      negotiationResults: unknown[];
    };
    for (const request of fixtures.negotiationRequests) {
      expect(connectorNegotiationRequestSchema.safeParse(request).success).toBe(true);
    }
    for (const result of fixtures.negotiationResults) {
      expect(connectorNegotiationResultSchema.safeParse(result).success).toBe(true);
    }
  });
});
