import type { ProtocolVersion, TransportLimits } from '@funny/shared/runner-v2/common';
import { FailureCode, RunnerCapability } from '@funny/shared/runner-v2/common';
import type {
  EventResumeCursor,
  RunnerHello,
  TerminalResumeCursor,
} from '@funny/shared/runner-v2/control';

import { log } from '../../lib/logger.js';
import type { RunnerGrpcConfig } from './config.js';
import type {
  RunnerGrpcCall,
  RunnerGrpcCallContext,
  RunnerGrpcHandler,
} from './runner-grpc-server.js';
import { RunnerGrpcSessionRegistry } from './session-registry.js';
import { observeRunnerGrpc } from './transport-observability.js';

type Version = Pick<ProtocolVersion, 'major' | 'minor'>;
type WireVersion = Partial<Version>;
type EventCursor = Pick<EventResumeCursor, 'executionId' | 'lastAcceptedSequence'>;
type TerminalCursor = Pick<TerminalResumeCursor, 'terminalId' | 'lastSeenOutputSequence'>;
type Limits = Pick<
  TransportLimits,
  | 'maxMessageBytes'
  | 'maxFrameBytes'
  | 'maxPendingOperations'
  | 'maxActiveTunnels'
  | 'maxActiveTerminals'
  | 'maxBufferedBytesPerClass'
>;
type WireUnsigned64 = string | number | bigint;
type WireCapability = RunnerCapability | keyof typeof RunnerCapability | string;
type WireLimits = Omit<Limits, 'maxBufferedBytesPerClass'> & {
  maxBufferedBytesPerClass: WireUnsigned64;
};
type Hello = Omit<
  Pick<
    RunnerHello,
    | 'supportedVersions'
    | 'runner'
    | 'capabilities'
    | 'requestedLimits'
    | 'eventCursors'
    | 'terminalCursors'
  >,
  'supportedVersions' | 'capabilities' | 'requestedLimits'
> & {
  supportedVersions: WireVersion[];
  capabilities: WireCapability[];
  requestedLimits?: Partial<WireLimits>;
};

interface ControlRequestWire {
  message?: string;
  hello?: Hello;
  heartbeat?: { ordinal?: string | number | bigint };
  commandOutcome?: unknown;
  cancellationAcknowledgement?: unknown;
  closing?: { reason?: string };
}

export interface AcceptedResumeCursors {
  eventCursors: EventCursor[];
  terminalCursors: TerminalCursor[];
}

export interface ControlNegotiationOptions {
  supportedVersions?: Version[];
  supportedCapabilities?: RunnerCapability[];
  resolveResumeCursors?: (
    context: RunnerGrpcCallContext,
    hello: Hello,
  ) => Promise<AcceptedResumeCursors>;
  observeHealth?: (healthy: boolean) => void;
}

const DEFAULT_SUPPORTED_VERSIONS: Version[] = [{ major: 2, minor: 0 }];
const DEFAULT_SUPPORTED_CAPABILITIES = [
  RunnerCapability.OPERATIONS,
  RunnerCapability.EVENTS,
  RunnerCapability.HTTP_TUNNEL,
  RunnerCapability.TERMINAL,
];

function requestKind(request: ControlRequestWire): string | undefined {
  if (typeof request.message === 'string') return request.message;
  if (request.hello) return 'hello';
  if (request.heartbeat) return 'heartbeat';
  if (request.commandOutcome) return 'commandOutcome';
  if (request.cancellationAcknowledgement) return 'cancellationAcknowledgement';
  if (request.closing) return 'closing';
  return undefined;
}

function selectVersion(offered: WireVersion[], supported: Version[]): Version | null {
  // proto3 omits scalar fields whose value is zero. The Buf-based runner
  // therefore sends version 2.0 as { major: 2 }, while proto-loader leaves the
  // absent minor undefined when defaults are disabled.
  const normalized = offered.map((candidate) => ({
    major: candidate.major ?? 0,
    minor: candidate.minor ?? 0,
  }));
  const matches = normalized.filter((candidate) =>
    supported.some(
      (available) => available.major === candidate.major && available.minor === candidate.minor,
    ),
  );
  matches.sort((a, b) => b.major - a.major || b.minor - a.minor);
  return matches[0] ?? null;
}

function enabledCapabilities(
  offered: WireCapability[],
  supported: RunnerCapability[],
): RunnerCapability[] {
  const available = new Set(supported);
  const normalized = offered
    .map((capability) => {
      if (typeof capability === 'number') return capability;
      const generatedName = capability.replace(/^RUNNER_CAPABILITY_/, '');
      const value = RunnerCapability[generatedName as keyof typeof RunnerCapability];
      return typeof value === 'number' ? value : RunnerCapability.UNSPECIFIED;
    })
    .filter((capability): capability is RunnerCapability => Number.isInteger(capability));
  return [...new Set(normalized)].filter(
    (capability) => capability !== RunnerCapability.UNSPECIFIED && available.has(capability),
  );
}

function bounded(requested: number | undefined, maximum: number): number {
  return requested && requested > 0 ? Math.min(requested, maximum) : maximum;
}

function boundedBigInt(requested: WireUnsigned64 | undefined, maximum: number): bigint {
  if (requested === undefined) return BigInt(maximum);
  let parsed: bigint;
  try {
    parsed = BigInt(requested);
  } catch {
    return BigInt(maximum);
  }
  if (parsed <= 0n) return BigInt(maximum);
  return parsed < BigInt(maximum) ? parsed : BigInt(maximum);
}

function effectiveLimits(
  requested: Partial<WireLimits> | undefined,
  config: RunnerGrpcConfig,
): Limits {
  const maxMessageBytes = bounded(requested?.maxMessageBytes, config.maxMessageBytes);
  return {
    maxMessageBytes,
    maxFrameBytes: Math.min(
      bounded(requested?.maxFrameBytes, config.maxFrameBytes),
      maxMessageBytes,
    ),
    maxPendingOperations: bounded(requested?.maxPendingOperations, config.maxPendingOperations),
    maxActiveTunnels: bounded(requested?.maxActiveTunnels, config.maxActiveTunnels),
    maxActiveTerminals: bounded(requested?.maxActiveTerminals, config.maxActiveTerminals),
    maxBufferedBytesPerClass: boundedBigInt(
      requested?.maxBufferedBytesPerClass,
      config.maxBufferedBytesPerClass,
    ),
  };
}

function duration(milliseconds: number): { seconds: string; nanos: number } {
  return {
    seconds: String(Math.floor(milliseconds / 1_000)),
    nanos: (milliseconds % 1_000) * 1_000_000,
  };
}

function timestamp(now = Date.now()): { seconds: string; nanos: number } {
  return {
    seconds: String(Math.floor(now / 1_000)),
    nanos: (now % 1_000) * 1_000_000,
  };
}

function writeFailure(
  call: RunnerGrpcCall,
  code: FailureCode,
  message: string,
  details?: Record<string, number>,
): void {
  call.write({
    failure: {
      code,
      message,
      retryable: false,
      ...(details
        ? {
            details: {
              fields: Object.fromEntries(
                Object.entries(details).map(([key, value]) => [key, { numberValue: value }]),
              ),
            },
          }
        : {}),
    },
  });
  call.end();
}

function supportedRange(versions: Version[]): Record<string, number> {
  const ordered = [...versions].sort((a, b) => a.major - b.major || a.minor - b.minor);
  const first = ordered[0];
  const last = ordered.at(-1);
  return {
    minimumMajor: first?.major ?? 0,
    minimumMinor: first?.minor ?? 0,
    maximumMajor: last?.major ?? 0,
    maximumMinor: last?.minor ?? 0,
  };
}

export function createControlNegotiationHandler(
  config: RunnerGrpcConfig,
  sessions: RunnerGrpcSessionRegistry,
  options: ControlNegotiationOptions = {},
): RunnerGrpcHandler {
  const supportedVersions = options.supportedVersions ?? DEFAULT_SUPPORTED_VERSIONS;
  const supportedCapabilities = options.supportedCapabilities ?? DEFAULT_SUPPORTED_CAPABILITIES;
  const resolveResumeCursors =
    options.resolveResumeCursors ??
    (async (): Promise<AcceptedResumeCursors> => ({ eventCursors: [], terminalCursors: [] }));

  return (call, context) => {
    let state: 'awaiting-hello' | 'active' | 'closed' = 'awaiting-hello';
    let sessionEpoch: bigint | null = null;
    const runnerId = context.principal.runnerId;

    const deactivate = () => {
      if (sessionEpoch !== null) sessions.deactivate(runnerId, sessionEpoch);
    };
    call.once('cancelled', deactivate);
    call.once('close', deactivate);
    call.once('error', deactivate);
    call.once('finish', deactivate);

    const handleRequest = async (raw: Record<string, unknown>): Promise<void> => {
      if (state === 'closed') return;
      const request = raw as ControlRequestWire;
      const kind = requestKind(request);

      if (state === 'awaiting-hello') {
        if (kind !== 'hello' || !request.hello) {
          state = 'closed';
          writeFailure(
            call,
            FailureCode.INVALID_ARGUMENT,
            'RunnerHello must be the first control message',
          );
          return;
        }
        if (!request.hello.runner?.instanceId) {
          state = 'closed';
          writeFailure(
            call,
            FailureCode.INVALID_ARGUMENT,
            'RunnerHello requires a runner instance ID',
          );
          return;
        }

        const hello: Hello = {
          ...request.hello,
          supportedVersions: request.hello.supportedVersions ?? [],
          capabilities: request.hello.capabilities ?? [],
          eventCursors: request.hello.eventCursors ?? [],
          terminalCursors: request.hello.terminalCursors ?? [],
        };

        const selectedVersion = selectVersion(hello.supportedVersions, supportedVersions);
        if (!selectedVersion) {
          options.observeHealth?.(false);
          state = 'closed';
          log.warn('Rejected incompatible runner gRPC protocol', {
            namespace: 'runner-grpc',
            correlationId: context.correlationId,
            runnerId: context.principal.runnerId,
            status: 'UNSUPPORTED_PROTOCOL',
          });
          writeFailure(
            call,
            FailureCode.UNSUPPORTED_PROTOCOL,
            'runner protocol version is not supported',
            supportedRange(supportedVersions),
          );
          return;
        }

        const capabilities = enabledCapabilities(hello.capabilities, supportedCapabilities);
        const limits = effectiveLimits(hello.requestedLimits, config);
        const cursors = await resolveResumeCursors(context, hello);
        sessionEpoch = sessions.activate(
          runnerId,
          {
            invalidate: (reason) => {
              if (state === 'closed') return;
              state = 'closed';
              writeFailure(
                call,
                FailureCode.UNAVAILABLE,
                reason === 'session-replaced'
                  ? 'runner session was superseded by a newer connection'
                  : 'runner session is no longer active',
              );
            },
          },
          context.principal.userId,
        );
        state = 'active';
        options.observeHealth?.(true);
        call.write({
          hello: {
            selectedVersion,
            sessionEpoch: String(sessionEpoch),
            enabledCapabilities: capabilities,
            effectiveLimits: {
              ...limits,
              maxBufferedBytesPerClass: String(limits.maxBufferedBytesPerClass),
            },
            heartbeatInterval: duration(config.heartbeatIntervalMs),
            heartbeatTimeout: duration(config.heartbeatTimeoutMs),
            acceptedEventCursors: cursors.eventCursors.map((cursor) => ({
              ...cursor,
              lastAcceptedSequence: String(cursor.lastAcceptedSequence),
            })),
            acceptedTerminalCursors: cursors.terminalCursors.map((cursor) => ({
              ...cursor,
              lastSeenOutputSequence: String(cursor.lastSeenOutputSequence),
            })),
          },
        });
        log.info('Negotiated runner gRPC control stream', {
          namespace: 'runner-grpc',
          correlationId: context.correlationId,
          runnerId: context.principal.runnerId,
          protocolMajor: selectedVersion.major,
          protocolMinor: selectedVersion.minor,
          capabilityCount: capabilities.length,
          sessionEpoch: String(sessionEpoch),
        });
        observeRunnerGrpc({
          event: 'session-activated',
          streamClass: 'control',
          status: 'ok',
          runnerId,
          correlationId: context.correlationId,
          protocolVersion: `runner.v${selectedVersion.major}.${selectedVersion.minor}`,
          sessionEpoch,
        });
        return;
      }

      if (kind === 'heartbeat' && request.heartbeat) {
        if (sessionEpoch === null || !sessions.heartbeat(runnerId, sessionEpoch)) {
          options.observeHealth?.(false);
          state = 'closed';
          writeFailure(call, FailureCode.UNAVAILABLE, 'runner session is no longer active');
          return;
        }
        options.observeHealth?.(true);
        call.write({
          heartbeat: {
            acknowledgedOrdinal: String(request.heartbeat.ordinal ?? 0),
            receivedAt: timestamp(),
          },
        });
        return;
      }
      if (kind === 'closing') {
        state = 'closed';
        deactivate();
        call.end();
        return;
      }
      if (kind === 'commandOutcome' || kind === 'cancellationAcknowledgement') return;

      state = 'closed';
      options.observeHealth?.(false);
      writeFailure(
        call,
        FailureCode.INVALID_ARGUMENT,
        'invalid control message for active session',
      );
    };

    call.on('data', (request: Record<string, unknown>) => {
      call.pause();
      void handleRequest(request)
        .catch(() => {
          state = 'closed';
          writeFailure(call, FailureCode.INTERNAL, 'control negotiation failed');
        })
        .finally(() => {
          if (state !== 'closed') call.resume();
        });
    });
    call.once('end', () => {
      state = 'closed';
      call.end();
    });
  };
}
