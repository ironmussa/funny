// Protocol constants, capability names and the field schemas the remote
// connector messages share. The field schemas are internal: the public entry
// (`../remote-connector-protocol.js`) re-exports only the constants.
import { valid } from 'semver';
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

export const idSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const base64UrlSchema = z
  .string()
  .min(16)
  .max(16_384)
  .regex(/^[A-Za-z0-9_-]+={0,2}$/);
export const isoTimestampSchema = z.iso.datetime({ offset: true });
export const semanticVersionSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((version) => valid(version) !== null, 'Invalid semantic version');
export const protocolVersionsSchema = z
  .array(z.number().int().positive().max(65_535))
  .min(1)
  .max(8)
  .refine((versions) => new Set(versions).size === versions.length, 'Duplicate protocol version');
export const fingerprintSchema = z
  .string()
  .min(16)
  .max(256)
  .regex(/^SHA256:[A-Za-z0-9+/_-]+={0,2}$/);
export const boundedOutputSchema = z
  .string()
  .max(REMOTE_CONNECTOR_MAX_OUTPUT_BYTES)
  .refine(
    (output) => new TextEncoder().encode(output).byteLength <= REMOTE_CONNECTOR_MAX_OUTPUT_BYTES,
    'Remote output exceeds byte limit',
  );
