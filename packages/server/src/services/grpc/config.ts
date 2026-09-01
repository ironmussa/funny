import { RUNNER_GRPC_MAX_MESSAGE_BYTES } from '@funny/shared/runner-protocol';

export interface RunnerGrpcConfig {
  enabled: boolean;
  host: string;
  port: number;
  maxMessageBytes: number;
  maxConcurrentStreamsPerRunner: number;
  authTimeoutMs: number;
  maxFrameBytes: number;
  maxPendingOperations: number;
  idempotencyRetentionMs: number;
  maxActiveTunnels: number;
  maxActiveTerminals: number;
  maxBufferedBytesPerClass: number;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
}

const DEFAULT_PORT = 50051;
const DEFAULT_MAX_MESSAGE_BYTES = RUNNER_GRPC_MAX_MESSAGE_BYTES;
const DEFAULT_MAX_CONCURRENT_STREAMS = 10;
const DEFAULT_AUTH_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_FRAME_BYTES = 64 * 1024;
const DEFAULT_MAX_PENDING_OPERATIONS = 32;
const DEFAULT_IDEMPOTENCY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ACTIVE_TUNNELS = 4;
const DEFAULT_MAX_ACTIVE_TERMINALS = 8;
const DEFAULT_MAX_BUFFERED_BYTES_PER_CLASS = 1024 * 1024;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 45_000;

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

/** Resolve the gRPC-only runner transport configuration. */
export function resolveRunnerGrpcConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): RunnerGrpcConfig {
  const config = {
    enabled: env.RUNNER_GRPC_ENABLED !== 'false',
    host: env.RUNNER_GRPC_HOST || '127.0.0.1',
    port: positiveInteger(env.RUNNER_GRPC_PORT, DEFAULT_PORT, 'RUNNER_GRPC_PORT'),
    maxMessageBytes: positiveInteger(
      env.RUNNER_GRPC_MAX_MESSAGE_BYTES,
      DEFAULT_MAX_MESSAGE_BYTES,
      'RUNNER_GRPC_MAX_MESSAGE_BYTES',
    ),
    maxConcurrentStreamsPerRunner: positiveInteger(
      env.RUNNER_GRPC_MAX_STREAMS_PER_RUNNER,
      DEFAULT_MAX_CONCURRENT_STREAMS,
      'RUNNER_GRPC_MAX_STREAMS_PER_RUNNER',
    ),
    authTimeoutMs: positiveInteger(
      env.RUNNER_GRPC_AUTH_TIMEOUT_MS,
      DEFAULT_AUTH_TIMEOUT_MS,
      'RUNNER_GRPC_AUTH_TIMEOUT_MS',
    ),
    maxFrameBytes: positiveInteger(
      env.RUNNER_GRPC_MAX_FRAME_BYTES,
      DEFAULT_MAX_FRAME_BYTES,
      'RUNNER_GRPC_MAX_FRAME_BYTES',
    ),
    maxPendingOperations: positiveInteger(
      env.RUNNER_GRPC_MAX_PENDING_OPERATIONS,
      DEFAULT_MAX_PENDING_OPERATIONS,
      'RUNNER_GRPC_MAX_PENDING_OPERATIONS',
    ),
    idempotencyRetentionMs: positiveInteger(
      env.RUNNER_GRPC_IDEMPOTENCY_RETENTION_MS,
      DEFAULT_IDEMPOTENCY_RETENTION_MS,
      'RUNNER_GRPC_IDEMPOTENCY_RETENTION_MS',
    ),
    maxActiveTunnels: positiveInteger(
      env.RUNNER_GRPC_MAX_ACTIVE_TUNNELS,
      DEFAULT_MAX_ACTIVE_TUNNELS,
      'RUNNER_GRPC_MAX_ACTIVE_TUNNELS',
    ),
    maxActiveTerminals: positiveInteger(
      env.RUNNER_GRPC_MAX_ACTIVE_TERMINALS,
      DEFAULT_MAX_ACTIVE_TERMINALS,
      'RUNNER_GRPC_MAX_ACTIVE_TERMINALS',
    ),
    maxBufferedBytesPerClass: positiveInteger(
      env.RUNNER_GRPC_MAX_BUFFERED_BYTES_PER_CLASS,
      DEFAULT_MAX_BUFFERED_BYTES_PER_CLASS,
      'RUNNER_GRPC_MAX_BUFFERED_BYTES_PER_CLASS',
    ),
    heartbeatIntervalMs: positiveInteger(
      env.RUNNER_GRPC_HEARTBEAT_INTERVAL_MS,
      DEFAULT_HEARTBEAT_INTERVAL_MS,
      'RUNNER_GRPC_HEARTBEAT_INTERVAL_MS',
    ),
    heartbeatTimeoutMs: positiveInteger(
      env.RUNNER_GRPC_HEARTBEAT_TIMEOUT_MS,
      DEFAULT_HEARTBEAT_TIMEOUT_MS,
      'RUNNER_GRPC_HEARTBEAT_TIMEOUT_MS',
    ),
  };
  if (config.maxFrameBytes > config.maxMessageBytes) {
    throw new Error('RUNNER_GRPC_MAX_FRAME_BYTES must not exceed RUNNER_GRPC_MAX_MESSAGE_BYTES');
  }
  if (config.heartbeatTimeoutMs <= config.heartbeatIntervalMs) {
    throw new Error(
      'RUNNER_GRPC_HEARTBEAT_TIMEOUT_MS must exceed RUNNER_GRPC_HEARTBEAT_INTERVAL_MS',
    );
  }
  return config;
}
