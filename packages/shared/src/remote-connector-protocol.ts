import { lt } from 'semver';

import { canonicalJsonWithKeyOrder } from './lib/canonical-json.js';
import {
  REMOTE_CONNECTOR_PROTOCOL_VERSIONS,
  REMOTE_CONNECTOR_MAX_REQUEST_AGE_MS,
  REMOTE_CONNECTOR_MAX_REQUEST_LIFETIME_MS,
  REMOTE_CONNECTOR_MAX_CLOCK_SKEW_MS,
  REMOTE_CONNECTOR_ENROLMENT_TTL_MS,
  REMOTE_CONNECTOR_TARGET_CONFIG_MAX_LIFETIME_MS,
  REMOTE_CONNECTOR_TARGET_SIGNATURE_DOMAIN,
  REMOTE_CONNECTOR_REQUEST_SIGNATURE_DOMAIN,
  REMOTE_CONNECTOR_APPROVAL_SIGNATURE_DOMAIN,
  base64UrlSchema,
  semanticVersionSchema,
} from './remote-connector-protocol/fields.js';
import {
  connectorHelloSchema,
  connectorNegotiationRequestSchema,
  credentialEnvelopeBindingSchema,
  credentialEnrolmentEnvelopeSchema,
  remoteTargetConfigSchema,
  signedTargetConfigSchema,
  remoteProductionApprovalSchema,
  unsignedRemoteExecutionRequestSchema,
  remoteExecutionDigestPayloadSchema,
  remoteExecutionRequestSchema,
} from './remote-connector-protocol/schemas.js';
import type {
  ConnectorHello,
  ConnectorNegotiationRequest,
  ConnectorNegotiationResult,
  CredentialEnvelopeBinding,
  CredentialEnrolmentEnvelope,
  RemoteArgumentValue,
  RemoteOperation,
  RemoteTargetConfig,
  SignedTargetConfig,
  RemoteProductionApproval,
  UnsignedRemoteExecutionRequest,
  RemoteExecutionRequest,
} from './remote-connector-protocol/schemas.js';

export {
  REMOTE_CONNECTOR_PROTOCOL_VERSION,
  REMOTE_CONNECTOR_PROTOCOL_VERSIONS,
  REMOTE_CONNECTOR_MAX_OUTPUT_BYTES,
  REMOTE_CONNECTOR_MAX_REQUEST_AGE_MS,
  REMOTE_CONNECTOR_MAX_REQUEST_LIFETIME_MS,
  REMOTE_CONNECTOR_MAX_CLOCK_SKEW_MS,
  REMOTE_CONNECTOR_PAIRING_TTL_MS,
  REMOTE_CONNECTOR_ENROLMENT_TTL_MS,
  REMOTE_CONNECTOR_TARGET_CONFIG_MAX_LIFETIME_MS,
  REMOTE_CONNECTOR_SIGNATURE_ALGORITHM,
  REMOTE_CONNECTOR_TARGET_SIGNATURE_DOMAIN,
  REMOTE_CONNECTOR_REQUEST_SIGNATURE_DOMAIN,
  REMOTE_CONNECTOR_APPROVAL_SIGNATURE_DOMAIN,
  connectorCapabilities,
} from './remote-connector-protocol/fields.js';
export type { ConnectorCapability } from './remote-connector-protocol/fields.js';
export * from './remote-connector-protocol/schemas.js';

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number';
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

/** Code-unit key order: the connector's signed digests must not depend on locale. */
function codeUnitOrder(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalJson<T>(value: T): string {
  return canonicalJsonWithKeyOrder(value, codeUnitOrder);
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export async function sha256Digest<T>(value: T): Promise<string> {
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
): RemoteExecutionRequest['arguments'] {
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
      if (!isString(value)) throw new Error(`Argument ${name} must be a string`);
      if (value.length > definition.maxLength)
        throw new Error(`Argument ${name} exceeds its maximum length`);
      if (definition.enum && !definition.enum.includes(value))
        throw new Error(`Argument ${name} is not allowlisted`);
      if (definition.pattern && !new RegExp(definition.pattern, 'u').test(value))
        throw new Error(`Argument ${name} does not match its pattern`);
    } else if (definition.type === 'integer') {
      if (!isNumber(value) || !Number.isSafeInteger(value))
        throw new Error(`Argument ${name} must be an integer`);
      if (definition.minimum !== undefined && value < definition.minimum)
        throw new Error(`Argument ${name} is below its minimum`);
      if (definition.maximum !== undefined && value > definition.maximum)
        throw new Error(`Argument ${name} is above its maximum`);
    } else if (!isBoolean(value)) {
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
