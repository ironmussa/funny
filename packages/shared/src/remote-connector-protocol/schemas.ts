// Wire constants, zod schemas and inferred types of the remote connector protocol
// (re-exported from `../remote-connector-protocol.js`).
import { z } from 'zod';

import {
  REMOTE_CONNECTOR_PROTOCOL_VERSION,
  REMOTE_CONNECTOR_MAX_OUTPUT_BYTES,
  REMOTE_CONNECTOR_SIGNATURE_ALGORITHM,
  connectorCapabilities,
  idSchema,
  base64UrlSchema,
  isoTimestampSchema,
  semanticVersionSchema,
  protocolVersionsSchema,
  fingerprintSchema,
  boundedOutputSchema,
} from './fields.js';

export const connectorCapabilitySchema = z.enum(connectorCapabilities);
export const connectorCapabilityTokenSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*-v[1-9][0-9]*$/);

export const connectorHelloSchema = z
  .object({
    kind: z.literal('hello'),
    connectorId: idSchema,
    productVersion: semanticVersionSchema,
    protocolVersions: protocolVersionsSchema,
    capabilities: z.array(connectorCapabilityTokenSchema).min(1),
    platform: z.enum(['win32', 'darwin', 'linux']),
    architecture: z.enum(['x64', 'arm64']),
    isolation: z.enum(['verified', 'failed']),
    keyVersion: z.number().int().positive(),
    publicKey: base64UrlSchema,
    publicKeyFingerprint: fingerprintSchema,
  })
  .strict();

export const connectorNegotiationRequestSchema = z
  .object({
    kind: z.literal('negotiate'),
    protocolVersions: protocolVersionsSchema,
    requiredCapabilities: z.array(connectorCapabilityTokenSchema).max(32),
    runtimeVersion: semanticVersionSchema,
  })
  .strict();

export const connectorNegotiationResultSchema = z.discriminatedUnion('compatible', [
  z
    .object({
      kind: z.literal('negotiated'),
      compatible: z.literal(true),
      protocolVersion: z.literal(REMOTE_CONNECTOR_PROTOCOL_VERSION),
      capabilities: z.array(connectorCapabilityTokenSchema).min(1),
      connectorVersion: semanticVersionSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('negotiated'),
      compatible: z.literal(false),
      reason: z.enum([
        'no-common-protocol',
        'missing-capability',
        'revoked-connector',
        'peer-version-too-old',
        'revoked-peer',
        'isolation-unavailable',
      ]),
      connectorVersion: semanticVersionSchema,
    })
    .strict(),
]);

export const connectorPairingRegistrationSchema = z
  .object({
    connector: connectorHelloSchema,
    pairingCodeHash: base64UrlSchema,
    pairingExpiresAt: isoTimestampSchema,
  })
  .strict();

export const connectorPairingConfirmationSchema = z
  .object({
    connectorId: idSchema,
    runnerId: idSchema,
    pairingCode: z.string().regex(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/),
    publicKeyFingerprint: fingerprintSchema,
  })
  .strict();

export const connectorPairingStatusRequestSchema = z
  .object({
    kind: z.literal('pairing-status'),
    protocolVersion: z.literal(REMOTE_CONNECTOR_PROTOCOL_VERSION),
  })
  .strict();

export const connectorPairingStatusResultSchema = z
  .object({
    kind: z.literal('pairing-status-result'),
    protocolVersion: z.literal(REMOTE_CONNECTOR_PROTOCOL_VERSION),
    registration: connectorPairingRegistrationSchema.nullable(),
    pairedRunnerId: idSchema.nullable(),
  })
  .strict();

export const connectorPairingConfirmationRequestSchema = z
  .object({
    kind: z.literal('pairing-confirmation'),
    protocolVersion: z.literal(REMOTE_CONNECTOR_PROTOCOL_VERSION),
    confirmation: connectorPairingConfirmationSchema,
  })
  .strict();

export const connectorPairingConfirmationResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      kind: z.literal('pairing-confirmation-result'),
      protocolVersion: z.literal(REMOTE_CONNECTOR_PROTOCOL_VERSION),
      status: z.literal('paired'),
      connectorId: idSchema,
      runnerId: idSchema,
      keyVersion: z.number().int().positive(),
      publicKeyFingerprint: fingerprintSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('pairing-confirmation-result'),
      protocolVersion: z.literal(REMOTE_CONNECTOR_PROTOCOL_VERSION),
      status: z.literal('rejected'),
      errorCode: z.literal('PAIRING_DENIED'),
    })
    .strict(),
]);

export const credentialEnvelopeBindingSchema = z
  .object({
    protocolVersion: z.literal(REMOTE_CONNECTOR_PROTOCOL_VERSION),
    connectorId: idSchema,
    runnerId: idSchema,
    connectorKeyVersion: z.number().int().positive(),
    targetId: idSchema,
    credentialVersion: z.number().int().positive(),
    expiresAt: isoTimestampSchema,
  })
  .strict();

export const credentialEnrolmentEnvelopeSchema = z
  .object({
    kind: z.literal('credential-enrolment'),
    algorithm: z.literal('RSA-OAEP-256+A256GCM'),
    binding: credentialEnvelopeBindingSchema,
    wrappedKey: base64UrlSchema,
    iv: base64UrlSchema,
    ciphertext: base64UrlSchema,
  })
  .strict();

export const credentialMutationSchema = z.discriminatedUnion('kind', [
  credentialEnrolmentEnvelopeSchema,
  z
    .object({
      kind: z.literal('credential-delete'),
      binding: credentialEnvelopeBindingSchema,
    })
    .strict(),
]);

export const credentialMutationAcknowledgementSchema = z
  .object({
    kind: z.literal('credential-ack'),
    protocolVersion: z.literal(REMOTE_CONNECTOR_PROTOCOL_VERSION),
    connectorId: idSchema,
    targetId: idSchema,
    credentialVersion: z.number().int().positive(),
    status: z.enum(['stored', 'deleted', 'rejected']),
    errorCode: z.enum(['ENROLMENT_REJECTED', 'CREDENTIAL_UNAVAILABLE']).optional(),
  })
  .strict();

export const remoteArgumentValueSchema = z.union([
  z.string().max(4_096),
  z.number().int().safe(),
  z.boolean(),
]);

export const remoteArgumentDefinitionSchema = z
  .discriminatedUnion('type', [
    z
      .object({
        type: z.literal('string'),
        required: z.boolean().default(true),
        enum: z
          .array(z.string().max(512))
          .min(1)
          .max(100)
          .refine((values) => new Set(values).size === values.length, 'Duplicate allowlisted value')
          .optional(),
        pattern: z
          .string()
          .max(512)
          .refine((pattern) => {
            try {
              new RegExp(pattern, 'u');
              return true;
            } catch {
              return false;
            }
          }, 'Invalid argument pattern')
          .optional(),
        maxLength: z.number().int().positive().max(4_096).default(512),
      })
      .strict(),
    z
      .object({
        type: z.literal('integer'),
        required: z.boolean().default(true),
        minimum: z.number().int().safe().optional(),
        maximum: z.number().int().safe().optional(),
      })
      .strict(),
    z.object({ type: z.literal('boolean'), required: z.boolean().default(true) }).strict(),
  ])
  .superRefine((definition, context) => {
    if (
      definition.type === 'integer' &&
      definition.minimum !== undefined &&
      definition.maximum !== undefined &&
      definition.minimum > definition.maximum
    ) {
      context.addIssue({
        code: 'custom',
        path: ['minimum'],
        message: 'Integer argument minimum exceeds maximum',
      });
    }
  });

export const remoteCommandTokenSchema = z.union([
  z.object({ literal: z.string().min(1).max(4_096) }).strict(),
  z.object({ argument: idSchema }).strict(),
]);

export const remoteOperationSchema = z
  .object({
    id: idSchema,
    name: z.string().min(1).max(160),
    executable: z.string().min(1).max(1_024),
    argv: z.array(remoteCommandTokenSchema).max(128),
    arguments: z.record(idSchema, remoteArgumentDefinitionSchema),
    timeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(15 * 60_000),
    outputLimitBytes: z
      .number()
      .int()
      .min(1_024)
      .max(REMOTE_CONNECTOR_MAX_OUTPUT_BYTES)
      .default(REMOTE_CONNECTOR_MAX_OUTPUT_BYTES),
  })
  .strict()
  .superRefine((operation, context) => {
    if (Object.keys(operation.arguments).length > 128) {
      context.addIssue({
        code: 'custom',
        path: ['arguments'],
        message: 'Too many operation arguments',
      });
    }
  });

export const remoteTargetConfigSchema = z
  .object({
    protocolVersion: z.literal(REMOTE_CONNECTOR_PROTOCOL_VERSION),
    targetId: idSchema,
    configVersion: z.number().int().positive().max(0xffff_ffff),
    runnerId: idSchema,
    connectorId: idSchema,
    name: z.string().min(1).max(160),
    environment: z.enum(['development', 'staging', 'production']),
    enabled: z.boolean(),
    host: z.string().min(1).max(253),
    port: z.number().int().min(1).max(65_535).default(22),
    username: z.string().min(1).max(128),
    hostKeyFingerprints: z.array(fingerprintSchema).min(1).max(8),
    credentialRef: idSchema,
    credentialVersion: z.number().int().positive().max(0xffff_ffff),
    connectTimeoutMs: z.number().int().min(1_000).max(120_000),
    operations: z.array(remoteOperationSchema).min(1).max(100),
  })
  .strict()
  .superRefine((target, context) => {
    if (new Set(target.hostKeyFingerprints).size !== target.hostKeyFingerprints.length) {
      context.addIssue({
        code: 'custom',
        path: ['hostKeyFingerprints'],
        message: 'Duplicate host-key fingerprint',
      });
    }
    const operationIds = new Set<string>();
    for (const operation of target.operations) {
      if (operationIds.has(operation.id)) {
        context.addIssue({
          code: 'custom',
          path: ['operations'],
          message: `Duplicate operation id: ${operation.id}`,
        });
      }
      operationIds.add(operation.id);
      for (const token of operation.argv) {
        if ('argument' in token && !(token.argument in operation.arguments)) {
          context.addIssue({
            code: 'custom',
            path: ['operations', operation.id, 'argv'],
            message: `Unknown argument reference: ${token.argument}`,
          });
        }
      }
    }
  });

export const signedTargetConfigSchema = z
  .object({
    config: remoteTargetConfigSchema,
    issuedAt: isoTimestampSchema,
    expiresAt: isoTimestampSchema,
    configDigest: base64UrlSchema,
    signatureAlgorithm: z.literal(REMOTE_CONNECTOR_SIGNATURE_ALGORITHM),
    authorityKeyFingerprint: fingerprintSchema,
    signature: base64UrlSchema,
  })
  .strict();

export const targetConfigUpdateSchema = z
  .object({
    kind: z.literal('target-config-update'),
    protocolVersion: z.literal(REMOTE_CONNECTOR_PROTOCOL_VERSION),
    signedTarget: signedTargetConfigSchema,
  })
  .strict();

export const targetConfigAcknowledgementSchema = z.discriminatedUnion('status', [
  z
    .object({
      kind: z.literal('target-config-ack'),
      protocolVersion: z.literal(REMOTE_CONNECTOR_PROTOCOL_VERSION),
      connectorId: idSchema,
      targetId: idSchema,
      configVersion: z.number().int().positive().max(0xffff_ffff),
      configDigest: base64UrlSchema,
      status: z.literal('cached'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('target-config-ack'),
      protocolVersion: z.literal(REMOTE_CONNECTOR_PROTOCOL_VERSION),
      connectorId: idSchema,
      targetId: idSchema,
      configVersion: z.number().int().positive().max(0xffff_ffff),
      configDigest: base64UrlSchema,
      status: z.literal('rejected'),
      errorCode: z.literal('TARGET_UNAVAILABLE'),
    })
    .strict(),
]);

export const remoteExecutionActorSchema = z
  .object({
    userId: idSchema,
    kind: z.enum(['human', 'agent']),
  })
  .strict();

export const remoteProductionApprovalSchema = z
  .object({
    approvalId: idSchema,
    requestDigest: base64UrlSchema,
    approvedBy: idSchema,
    issuedAt: isoTimestampSchema,
    expiresAt: isoTimestampSchema,
    nonce: base64UrlSchema,
    signature: base64UrlSchema,
  })
  .strict();

export const unsignedRemoteExecutionRequestSchema = z
  .object({
    kind: z.literal('execute'),
    protocolVersion: z.literal(REMOTE_CONNECTOR_PROTOCOL_VERSION),
    requestId: idSchema,
    runnerId: idSchema,
    connectorId: idSchema,
    projectId: idSchema,
    threadId: idSchema.nullable(),
    targetId: idSchema,
    operationId: idSchema,
    arguments: z.record(idSchema, remoteArgumentValueSchema),
    actor: remoteExecutionActorSchema,
    issuedAt: isoTimestampSchema,
    expiresAt: isoTimestampSchema,
    nonce: base64UrlSchema,
    approval: remoteProductionApprovalSchema.optional(),
  })
  .strict();

export const remoteExecutionDigestPayloadSchema = unsignedRemoteExecutionRequestSchema.omit({
  approval: true,
});

export const remoteExecutionRequestSchema = unsignedRemoteExecutionRequestSchema
  .extend({
    requestDigest: base64UrlSchema,
    signature: base64UrlSchema,
  })
  .strict();

export const remoteCancellationSchema = z
  .object({
    kind: z.literal('cancel'),
    protocolVersion: z.literal(REMOTE_CONNECTOR_PROTOCOL_VERSION),
    requestId: idSchema,
    reason: z.enum(['user', 'timeout', 'shutdown']),
  })
  .strict();

export const connectorErrorCodes = [
  'INCOMPATIBLE_PROTOCOL',
  'ISOLATION_UNAVAILABLE',
  'PAIRING_DENIED',
  'ENROLMENT_REJECTED',
  'TARGET_UNAVAILABLE',
  'OPERATION_DENIED',
  'AUTHORIZATION_DENIED',
  'APPROVAL_REQUIRED',
  'APPROVAL_INVALID',
  'REPLAY_DETECTED',
  'HOST_KEY_MISMATCH',
  'CREDENTIAL_UNAVAILABLE',
  'SSH_CONNECTION_FAILED',
  'SSH_AUTHENTICATION_FAILED',
  'EXECUTION_TIMEOUT',
  'OUTPUT_LIMIT_EXCEEDED',
  'CANCELLED',
  'INTERNAL_ERROR',
] as const;

export const connectorErrorCodeSchema = z.enum(connectorErrorCodes);

export const remoteExecutionResultSchema = z
  .object({
    kind: z.literal('result'),
    protocolVersion: z.literal(REMOTE_CONNECTOR_PROTOCOL_VERSION),
    requestId: idSchema,
    status: z.enum(['succeeded', 'failed', 'cancelled']),
    exitCode: z.number().int().nullable(),
    stdout: boundedOutputSchema,
    stderr: boundedOutputSchema,
    truncated: z.boolean(),
    errorCode: connectorErrorCodeSchema.optional(),
    startedAt: isoTimestampSchema,
    completedAt: isoTimestampSchema,
  })
  .strict();

export const remoteExecutionAuditSchema = z
  .object({
    auditId: idSchema,
    requestId: idSchema,
    requestDigest: base64UrlSchema,
    actorId: idSchema,
    actorKind: z.enum(['human', 'agent']),
    projectId: idSchema,
    threadId: idSchema.nullable(),
    runnerId: idSchema,
    connectorId: idSchema,
    targetId: idSchema,
    operationId: idSchema,
    connectorKeyVersion: z.number().int().positive(),
    authorization: z.enum(['allowed', 'denied']),
    approval: z.enum(['not-required', 'approved', 'denied']),
    status: z.enum(['pending', 'succeeded', 'failed', 'cancelled']),
    errorCode: connectorErrorCodeSchema.optional(),
    createdAt: isoTimestampSchema,
    completedAt: isoTimestampSchema.optional(),
  })
  .strict();

export const connectorHealthRequestSchema = z
  .object({
    kind: z.literal('health'),
    protocolVersion: z.literal(REMOTE_CONNECTOR_PROTOCOL_VERSION),
  })
  .strict();

export const connectorHealthResultSchema = z
  .object({
    kind: z.literal('health-result'),
    protocolVersion: z.literal(REMOTE_CONNECTOR_PROTOCOL_VERSION),
    connector: connectorHelloSchema,
    status: z.enum(['healthy', 'incompatible', 'isolated-failure']),
    pairedRunnerId: idSchema.nullable(),
    providerStatus: z.enum(['available', 'unavailable']),
  })
  .strict();

export const connectorErrorResultSchema = z
  .object({
    kind: z.literal('error'),
    protocolVersion: z.literal(REMOTE_CONNECTOR_PROTOCOL_VERSION),
    requestId: idSchema.optional(),
    errorCode: connectorErrorCodeSchema,
  })
  .strict();

export const connectorIpcRequestSchema = z.discriminatedUnion('kind', [
  connectorNegotiationRequestSchema,
  connectorPairingStatusRequestSchema,
  connectorPairingConfirmationRequestSchema,
  connectorHealthRequestSchema,
  credentialMutationSchema,
  targetConfigUpdateSchema,
  remoteExecutionRequestSchema,
  remoteCancellationSchema,
]);

export const connectorIpcResponseSchema = z.discriminatedUnion('kind', [
  connectorNegotiationResultSchema,
  connectorPairingStatusResultSchema,
  connectorPairingConfirmationResultSchema,
  connectorHealthResultSchema,
  credentialMutationAcknowledgementSchema,
  targetConfigAcknowledgementSchema,
  remoteExecutionResultSchema,
  connectorErrorResultSchema,
]);

export type ConnectorHello = z.infer<typeof connectorHelloSchema>;
export type ConnectorNegotiationRequest = z.infer<typeof connectorNegotiationRequestSchema>;
export type ConnectorNegotiationResult = z.infer<typeof connectorNegotiationResultSchema>;
export type ConnectorPairingRegistration = z.infer<typeof connectorPairingRegistrationSchema>;
export type ConnectorPairingConfirmation = z.infer<typeof connectorPairingConfirmationSchema>;
export type ConnectorPairingStatusRequest = z.infer<typeof connectorPairingStatusRequestSchema>;
export type ConnectorPairingStatusResult = z.infer<typeof connectorPairingStatusResultSchema>;
export type ConnectorPairingConfirmationRequest = z.infer<
  typeof connectorPairingConfirmationRequestSchema
>;
export type ConnectorPairingConfirmationResult = z.infer<
  typeof connectorPairingConfirmationResultSchema
>;
export type CredentialEnvelopeBinding = z.infer<typeof credentialEnvelopeBindingSchema>;
export type CredentialEnrolmentEnvelope = z.infer<typeof credentialEnrolmentEnvelopeSchema>;
export type CredentialMutation = z.infer<typeof credentialMutationSchema>;
export type CredentialMutationAcknowledgement = z.infer<
  typeof credentialMutationAcknowledgementSchema
>;
export type RemoteArgumentValue = z.infer<typeof remoteArgumentValueSchema>;
export type RemoteArgumentDefinition = z.infer<typeof remoteArgumentDefinitionSchema>;
export type RemoteOperation = z.infer<typeof remoteOperationSchema>;
export type RemoteTargetConfig = z.infer<typeof remoteTargetConfigSchema>;
export type SignedTargetConfig = z.infer<typeof signedTargetConfigSchema>;
export type TargetConfigUpdate = z.infer<typeof targetConfigUpdateSchema>;
export type TargetConfigAcknowledgement = z.infer<typeof targetConfigAcknowledgementSchema>;
export type RemoteExecutionActor = z.infer<typeof remoteExecutionActorSchema>;
export type RemoteProductionApproval = z.infer<typeof remoteProductionApprovalSchema>;
export type UnsignedRemoteExecutionRequest = z.infer<typeof unsignedRemoteExecutionRequestSchema>;
export type RemoteExecutionDigestPayload = z.infer<typeof remoteExecutionDigestPayloadSchema>;
export type RemoteExecutionRequest = z.infer<typeof remoteExecutionRequestSchema>;
export type RemoteCancellation = z.infer<typeof remoteCancellationSchema>;
export type ConnectorErrorCode = z.infer<typeof connectorErrorCodeSchema>;
export type RemoteExecutionResult = z.infer<typeof remoteExecutionResultSchema>;
export type RemoteExecutionAudit = z.infer<typeof remoteExecutionAuditSchema>;
export type ConnectorHealthRequest = z.infer<typeof connectorHealthRequestSchema>;
export type ConnectorHealthResult = z.infer<typeof connectorHealthResultSchema>;
export type ConnectorErrorResult = z.infer<typeof connectorErrorResultSchema>;
export type ConnectorIpcRequest = z.infer<typeof connectorIpcRequestSchema>;
export type ConnectorIpcResponse = z.infer<typeof connectorIpcResponseSchema>;
