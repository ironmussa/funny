import { lt, valid } from 'semver';
import { z } from 'zod';

export const REMOTE_CONNECTOR_PROTOCOL_VERSION = 1 as const;
export const REMOTE_CONNECTOR_PROTOCOL_VERSIONS = [REMOTE_CONNECTOR_PROTOCOL_VERSION] as const;
export const REMOTE_CONNECTOR_MAX_OUTPUT_BYTES = 256 * 1024;
export const REMOTE_CONNECTOR_MAX_REQUEST_AGE_MS = 60_000;
export const REMOTE_CONNECTOR_MAX_REQUEST_LIFETIME_MS = 60_000;
export const REMOTE_CONNECTOR_MAX_CLOCK_SKEW_MS = 5_000;
export const REMOTE_CONNECTOR_PAIRING_TTL_MS = 10 * 60_000;
export const REMOTE_CONNECTOR_ENROLMENT_TTL_MS = 5 * 60_000;
export const REMOTE_CONNECTOR_TARGET_CONFIG_MAX_LIFETIME_MS = 30 * 24 * 60 * 60_000;
export const REMOTE_CONNECTOR_SIGNATURE_ALGORITHM = 'Ed25519' as const;
export const REMOTE_CONNECTOR_TARGET_SIGNATURE_DOMAIN =
  'funny-remote-connector-target-config-v1' as const;
export const REMOTE_CONNECTOR_REQUEST_SIGNATURE_DOMAIN =
  'funny-remote-connector-request-v1' as const;
export const REMOTE_CONNECTOR_APPROVAL_SIGNATURE_DOMAIN =
  'funny-remote-connector-production-approval-v1' as const;

export const connectorCapabilities = [
  'credential-enrolment-v1',
  'password-auth-v1',
  'ssh-exec-v1',
  'output-redaction-v1',
  'production-approval-v1',
  'target-config-v1',
] as const;

export type ConnectorCapability = (typeof connectorCapabilities)[number];

const idSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const base64UrlSchema = z
  .string()
  .min(16)
  .max(16_384)
  .regex(/^[A-Za-z0-9_-]+={0,2}$/);
const isoTimestampSchema = z.iso.datetime({ offset: true });
const semanticVersionSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((version) => valid(version) !== null, 'Invalid semantic version');
const protocolVersionsSchema = z
  .array(z.number().int().positive().max(65_535))
  .min(1)
  .max(8)
  .refine((versions) => new Set(versions).size === versions.length, 'Duplicate protocol version');
const fingerprintSchema = z
  .string()
  .min(16)
  .max(256)
  .regex(/^SHA256:[A-Za-z0-9+/_-]+={0,2}$/);
const boundedOutputSchema = z
  .string()
  .max(REMOTE_CONNECTOR_MAX_OUTPUT_BYTES)
  .refine(
    (output) => new TextEncoder().encode(output).byteLength <= REMOTE_CONNECTOR_MAX_OUTPUT_BYTES,
    'Remote output exceeds byte limit',
  );

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

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export async function sha256Digest(value: unknown): Promise<string> {
  const encoded = new TextEncoder().encode(canonicalJson(value));
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return toBase64Url(new Uint8Array(digest));
}

export async function createConnectorPairingCodeHash(
  connectorId: string,
  publicKeyFingerprint: string,
  pairingCode: string,
): Promise<string> {
  const encoded = new TextEncoder().encode(
    `funny-remote-connector-pairing-v1\0${connectorId}\0${publicKeyFingerprint}\0${pairingCode}`,
  );
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return toBase64Url(new Uint8Array(digest));
}

export async function createRemoteExecutionDigest(
  request: UnsignedRemoteExecutionRequest,
): Promise<string> {
  const { approval: _approval, ...digestPayload } =
    unsignedRemoteExecutionRequestSchema.parse(request);
  return sha256Digest(remoteExecutionDigestPayloadSchema.parse(digestPayload));
}

export function remoteExecutionSignaturePayload(requestDigest: string): Uint8Array {
  const digest = base64UrlSchema.parse(requestDigest);
  return new TextEncoder().encode(`${REMOTE_CONNECTOR_REQUEST_SIGNATURE_DOMAIN}\0${digest}`);
}

export function remoteProductionApprovalSignaturePayload(
  approval: Omit<RemoteProductionApproval, 'signature'> | RemoteProductionApproval,
): Uint8Array {
  const parsed = remoteProductionApprovalSchema.omit({ signature: true }).parse({
    approvalId: approval.approvalId,
    requestDigest: approval.requestDigest,
    approvedBy: approval.approvedBy,
    issuedAt: approval.issuedAt,
    expiresAt: approval.expiresAt,
    nonce: approval.nonce,
  });
  return new TextEncoder().encode(
    `${REMOTE_CONNECTOR_APPROVAL_SIGNATURE_DOMAIN}\0${canonicalJson(parsed)}`,
  );
}

export async function createTargetConfigDigest(config: RemoteTargetConfig): Promise<string> {
  return sha256Digest(remoteTargetConfigSchema.parse(config));
}

export async function validateSignedTargetConfigEnvelope(
  input: SignedTargetConfig,
  now = Date.now(),
): Promise<SignedTargetConfig> {
  const signedTarget = signedTargetConfigSchema.parse(input);
  const issuedAt = Date.parse(signedTarget.issuedAt);
  const expiresAt = Date.parse(signedTarget.expiresAt);
  if (issuedAt > now + REMOTE_CONNECTOR_MAX_CLOCK_SKEW_MS) {
    throw new Error('Target configuration issued in the future');
  }
  if (expiresAt <= now || expiresAt <= issuedAt) {
    throw new Error('Target configuration expired');
  }
  if (expiresAt - issuedAt > REMOTE_CONNECTOR_TARGET_CONFIG_MAX_LIFETIME_MS) {
    throw new Error('Target configuration lifetime exceeds policy');
  }
  if ((await createTargetConfigDigest(signedTarget.config)) !== signedTarget.configDigest) {
    throw new Error('Target configuration digest mismatch');
  }
  return signedTarget;
}

export function targetConfigSignaturePayload(
  signedTarget: Omit<SignedTargetConfig, 'signature'> | SignedTargetConfig,
): Uint8Array {
  const parsed = signedTargetConfigSchema.omit({ signature: true }).parse({
    config: signedTarget.config,
    issuedAt: signedTarget.issuedAt,
    expiresAt: signedTarget.expiresAt,
    configDigest: signedTarget.configDigest,
    signatureAlgorithm: signedTarget.signatureAlgorithm,
    authorityKeyFingerprint: signedTarget.authorityKeyFingerprint,
  });
  const metadata = {
    authorityKeyFingerprint: parsed.authorityKeyFingerprint,
    configDigest: parsed.configDigest,
    expiresAt: parsed.expiresAt,
    issuedAt: parsed.issuedAt,
    signatureAlgorithm: parsed.signatureAlgorithm,
  };
  return new TextEncoder().encode(
    `${REMOTE_CONNECTOR_TARGET_SIGNATURE_DOMAIN}\0${canonicalJson(metadata)}`,
  );
}

export function validateRemoteOperationArguments(
  operation: RemoteOperation,
  values: Record<string, RemoteArgumentValue>,
): Record<string, RemoteArgumentValue> {
  const unknown = Object.keys(values).find((key) => !(key in operation.arguments));
  if (unknown) throw new Error(`Unknown operation argument: ${unknown}`);

  const validated: Record<string, RemoteArgumentValue> = {};
  for (const [name, definition] of Object.entries(operation.arguments)) {
    const value = values[name];
    if (value === undefined) {
      if (definition.required) throw new Error(`Missing operation argument: ${name}`);
      continue;
    }
    if (definition.type === 'string') {
      if (typeof value !== 'string') throw new Error(`Argument ${name} must be a string`);
      if (value.length > definition.maxLength)
        throw new Error(`Argument ${name} exceeds its maximum length`);
      if (definition.enum && !definition.enum.includes(value))
        throw new Error(`Argument ${name} is not allowlisted`);
      if (definition.pattern && !new RegExp(definition.pattern, 'u').test(value))
        throw new Error(`Argument ${name} does not match its pattern`);
    } else if (definition.type === 'integer') {
      if (typeof value !== 'number' || !Number.isSafeInteger(value))
        throw new Error(`Argument ${name} must be an integer`);
      if (definition.minimum !== undefined && value < definition.minimum)
        throw new Error(`Argument ${name} is below its minimum`);
      if (definition.maximum !== undefined && value > definition.maximum)
        throw new Error(`Argument ${name} is above its maximum`);
    } else if (typeof value !== 'boolean') {
      throw new Error(`Argument ${name} must be a boolean`);
    }
    validated[name] = value;
  }
  return validated;
}

export function assertEnvelopeBinding(
  envelope: CredentialEnrolmentEnvelope,
  expected: CredentialEnvelopeBinding,
  now = Date.now(),
): void {
  const parsed = credentialEnrolmentEnvelopeSchema.parse(envelope);
  const expectedBinding = credentialEnvelopeBindingSchema.parse(expected);
  if (canonicalJson(parsed.binding) !== canonicalJson(expectedBinding)) {
    throw new Error('Credential envelope binding mismatch');
  }
  if (Date.parse(parsed.binding.expiresAt) <= now) {
    throw new Error('Credential envelope expired');
  }
  if (
    Date.parse(parsed.binding.expiresAt) >
    now + REMOTE_CONNECTOR_ENROLMENT_TTL_MS + REMOTE_CONNECTOR_MAX_CLOCK_SKEW_MS
  ) {
    throw new Error('Credential envelope lifetime exceeds policy');
  }
}

export function credentialEnvelopeAdditionalData(binding: CredentialEnvelopeBinding): Uint8Array {
  return new TextEncoder().encode(canonicalJson(credentialEnvelopeBindingSchema.parse(binding)));
}

export function negotiateConnectorProtocol(
  request: ConnectorNegotiationRequest,
  hello: ConnectorHello,
  options: {
    minimumConnectorVersion?: string;
    revokedVersions?: ReadonlySet<string>;
  } = {},
): ConnectorNegotiationResult {
  const parsedRequest = connectorNegotiationRequestSchema.parse(request);
  const parsedHello = connectorHelloSchema.parse(hello);
  if (options.revokedVersions?.has(parsedHello.productVersion)) {
    return {
      kind: 'negotiated',
      compatible: false,
      reason: 'revoked-connector',
      connectorVersion: parsedHello.productVersion,
    };
  }
  if (options.minimumConnectorVersion) {
    const minimumConnectorVersion = semanticVersionSchema.parse(options.minimumConnectorVersion);
    if (lt(parsedHello.productVersion, minimumConnectorVersion)) {
      return {
        kind: 'negotiated',
        compatible: false,
        reason: 'peer-version-too-old',
        connectorVersion: parsedHello.productVersion,
      };
    }
  }
  if (parsedHello.isolation !== 'verified') {
    return {
      kind: 'negotiated',
      compatible: false,
      reason: 'isolation-unavailable',
      connectorVersion: parsedHello.productVersion,
    };
  }
  const protocolVersion = [...REMOTE_CONNECTOR_PROTOCOL_VERSIONS]
    .sort((left, right) => right - left)
    .find(
      (version) =>
        parsedRequest.protocolVersions.includes(version) &&
        parsedHello.protocolVersions.includes(version),
    );
  if (protocolVersion === undefined) {
    return {
      kind: 'negotiated',
      compatible: false,
      reason: 'no-common-protocol',
      connectorVersion: parsedHello.productVersion,
    };
  }
  if (
    parsedRequest.requiredCapabilities.some(
      (capability) => !parsedHello.capabilities.includes(capability),
    )
  ) {
    return {
      kind: 'negotiated',
      compatible: false,
      reason: 'missing-capability',
      connectorVersion: parsedHello.productVersion,
    };
  }
  return {
    kind: 'negotiated',
    compatible: true,
    protocolVersion,
    capabilities: parsedHello.capabilities,
    connectorVersion: parsedHello.productVersion,
  };
}

export interface ValidatedRemoteExecution {
  request: RemoteExecutionRequest;
  target: RemoteTargetConfig;
  operation: RemoteOperation;
  arguments: Record<string, RemoteArgumentValue>;
}

export async function validateRemoteExecutionAgainstTarget(
  input: RemoteExecutionRequest,
  targetInput: RemoteTargetConfig,
  now = Date.now(),
): Promise<ValidatedRemoteExecution> {
  const request = remoteExecutionRequestSchema.parse(input);
  const target = remoteTargetConfigSchema.parse(targetInput);
  if (request.runnerId !== target.runnerId) throw new Error('Runner binding mismatch');
  if (request.connectorId !== target.connectorId) throw new Error('Connector binding mismatch');
  if (request.targetId !== target.targetId) throw new Error('Target binding mismatch');
  if (!target.enabled) throw new Error('Target is disabled');

  const issuedAt = Date.parse(request.issuedAt);
  const expiresAt = Date.parse(request.expiresAt);
  if (issuedAt > now + REMOTE_CONNECTOR_MAX_CLOCK_SKEW_MS) {
    throw new Error('Request issued in the future');
  }
  if (issuedAt < now - REMOTE_CONNECTOR_MAX_REQUEST_AGE_MS) {
    throw new Error('Request is too old');
  }
  if (expiresAt <= now || expiresAt <= issuedAt) throw new Error('Request expired');
  if (expiresAt - issuedAt > REMOTE_CONNECTOR_MAX_REQUEST_LIFETIME_MS) {
    throw new Error('Request lifetime exceeds policy');
  }

  const { requestDigest, signature: _signature, ...unsigned } = request;
  const expectedDigest = await createRemoteExecutionDigest(unsigned);
  if (requestDigest !== expectedDigest) throw new Error('Request digest mismatch');

  const operation = target.operations.find((candidate) => candidate.id === request.operationId);
  if (!operation) throw new Error('Unknown operation id');
  const args = validateRemoteOperationArguments(operation, request.arguments);

  if (target.environment === 'production') {
    if (!request.approval) throw new Error('Production approval required');
    if (request.approval.requestDigest !== requestDigest) {
      throw new Error('Production approval digest mismatch');
    }
    const approvalIssuedAt = Date.parse(request.approval.issuedAt);
    const approvalExpiresAt = Date.parse(request.approval.expiresAt);
    if (approvalIssuedAt > now + REMOTE_CONNECTOR_MAX_CLOCK_SKEW_MS) {
      throw new Error('Production approval issued in the future');
    }
    if (
      approvalExpiresAt <= now ||
      approvalExpiresAt <= approvalIssuedAt ||
      approvalExpiresAt - approvalIssuedAt > REMOTE_CONNECTOR_MAX_REQUEST_LIFETIME_MS
    ) {
      throw new Error('Production approval expired');
    }
  }

  return { request, target, operation, arguments: args };
}
