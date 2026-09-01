import { FailureCode } from '@funny/shared/runner-v2/common';

import type { RunnerTerminalEvent, RunnerTerminalPort } from '../runner-ports.js';
import type { RunnerGrpcConfig } from './config.js';
import type {
  RunnerGrpcCall,
  RunnerGrpcCallContext,
  RunnerGrpcHandler,
} from './runner-grpc-server.js';
import type { RunnerGrpcSessionRegistry } from './session-registry.js';

type WireFrame = Record<string, any>;

export type GrpcTerminalBrowserEvent = RunnerTerminalEvent;

export class GrpcTerminalUnavailableError extends Error {}
export class GrpcTerminalResourceExhaustedError extends Error {}

interface TerminalState {
  userId: string;
  cwd: string;
  projectId?: string;
  label?: string;
  shell?: string;
  lastInputOrdinal: bigint;
  lastOutputSequence: bigint;
  outputDecoder: TextDecoder;
}

interface ActiveTerminalStream {
  epoch: bigint;
  call: RunnerGrpcCall;
}

function unsigned(value: unknown): bigint | null {
  try {
    const parsed = BigInt(value as string | number | bigint);
    return parsed >= 0n ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Bridges the existing browser PTY event shape to the runner-initiated gRPC
 * terminal stream. Input is written once and never retained for reconnect.
 */
export class RunnerGrpcTerminalDispatcher implements RunnerTerminalPort {
  private readonly streams = new Map<string, ActiveTerminalStream>();
  private readonly terminals = new Map<string, TerminalState>();
  private readonly pendingResizes = new Map<
    string,
    { runnerId: string; columns: number; rows: number }
  >();
  private resizeFlushScheduled = false;

  constructor(
    private readonly config: RunnerGrpcConfig,
    private readonly sessions: RunnerGrpcSessionRegistry,
    private readonly relayToUser: (userId: string, event: Record<string, unknown>) => void,
  ) {}

  isConnected(runnerId: string): boolean {
    const stream = this.streams.get(runnerId);
    return !!stream && this.sessions.isActive(runnerId, stream.epoch);
  }

  isAvailable(runnerId: string): boolean {
    return this.isConnected(runnerId);
  }

  register(runnerId: string, epoch: bigint, call: RunnerGrpcCall): () => void {
    const stream = { epoch, call };
    this.streams.set(runnerId, stream);
    return () => {
      if (this.streams.get(runnerId) === stream) this.streams.delete(runnerId);
    };
  }

  dispatch(runnerId: string, userId: string, event: GrpcTerminalBrowserEvent): void {
    const stream = this.streams.get(runnerId);
    if (!stream || !this.sessions.isActive(runnerId, stream.epoch)) {
      throw new GrpcTerminalUnavailableError(`Runner ${runnerId} has no gRPC terminal stream`);
    }
    const terminalId = typeof event.data.id === 'string' ? event.data.id : '';
    if (!terminalId) throw new Error('terminal ID is required');
    const key = this.key(runnerId, terminalId);
    let state = this.terminals.get(key);

    if (event.type === 'pty:spawn') {
      if (!state && this.runnerTerminalCount(runnerId) >= this.config.maxActiveTerminals) {
        throw new GrpcTerminalResourceExhaustedError('runner terminal limit exceeded');
      }
      state = state ?? {
        userId,
        cwd: String(event.data.cwd ?? ''),
        ...(event.data.projectId ? { projectId: String(event.data.projectId) } : {}),
        ...(event.data.label ? { label: String(event.data.label) } : {}),
        ...(event.data.shell ? { shell: String(event.data.shell) } : {}),
        lastInputOrdinal: 0n,
        lastOutputSequence: 0n,
        outputDecoder: new TextDecoder(),
      };
      state.userId = userId;
      state.cwd = String(event.data.cwd ?? '');
      state.projectId = event.data.projectId ? String(event.data.projectId) : undefined;
      state.label = event.data.label ? String(event.data.label) : undefined;
      state.shell = event.data.shell ? String(event.data.shell) : undefined;
      this.terminals.set(key, state);
      this.write(stream, terminalId, {
        open: {
          terminalId,
          cwd: event.data.cwd ?? '',
          columns: event.data.cols ?? 80,
          rows: event.data.rows ?? 24,
          userId,
          ...(event.data.shell ? { shell: event.data.shell } : {}),
          ...(event.data.projectId ? { projectId: event.data.projectId } : {}),
          ...(event.data.label ? { label: event.data.label } : {}),
        },
      });
      return;
    }
    if (!state || state.userId !== userId)
      throw new GrpcTerminalUnavailableError('terminal session is unavailable');

    switch (event.type) {
      case 'pty:write': {
        const data = Buffer.from(String(event.data.data ?? ''), 'utf8');
        if (data.byteLength > this.config.maxFrameBytes) {
          throw new GrpcTerminalResourceExhaustedError(
            'terminal input exceeds negotiated frame limit',
          );
        }
        // This ordinal is only for live duplicate suppression. The frame is not
        // stored anywhere, so an ambiguous disconnect can never replay input.
        this.write(stream, terminalId, {
          input: { ordinal: (++state.lastInputOrdinal).toString(), data },
        });
        return;
      }
      case 'pty:resize':
        this.pendingResizes.set(key, {
          runnerId,
          columns: event.data.cols ?? 80,
          rows: event.data.rows ?? 24,
        });
        this.scheduleResizeFlush();
        return;
      case 'pty:signal':
        this.write(stream, terminalId, { signal: { signal: event.data.signal ?? '' } });
        return;
      case 'pty:rename':
        state.label = typeof event.data.label === 'string' ? event.data.label : state.label;
        return;
      case 'pty:close':
      case 'pty:kill':
        this.pendingResizes.delete(key);
        this.write(stream, terminalId, { close: { reason: event.type } });
        this.terminals.delete(key);
        return;
      case 'pty:reconnect':
      case 'pty:restore':
        this.write(stream, terminalId, {
          resume: { terminalId, lastSeenOutputSequence: state.lastOutputSequence.toString() },
        });
    }
  }

  listSessions(runnerId: string, userId: string): Array<Record<string, unknown>> {
    const prefix = `${runnerId}\0`;
    const sessions: Array<Record<string, unknown>> = [];
    for (const [key, state] of this.terminals) {
      if (!key.startsWith(prefix) || state.userId !== userId) continue;
      sessions.push({
        ptyId: key.slice(prefix.length),
        cwd: state.cwd,
        ...(state.projectId ? { projectId: state.projectId } : {}),
        ...(state.label ? { label: state.label } : {}),
        ...(state.shell ? { shell: state.shell } : {}),
      });
    }
    return sessions;
  }

  receive(runnerId: string, epoch: bigint, call: RunnerGrpcCall, frame: WireFrame): void {
    const stream = this.streams.get(runnerId);
    if (!stream || stream.epoch !== epoch || stream.call !== call) return;
    const terminalId = typeof frame.terminalId === 'string' ? frame.terminalId : '';
    const state = this.terminals.get(this.key(runnerId, terminalId));
    if (!state) return;

    if (frame.output) {
      const sequence = unsigned(frame.output.sequence);
      const data = frame.output.data as Uint8Array | undefined;
      if (
        sequence === null ||
        !(data instanceof Uint8Array) ||
        data.byteLength > this.config.maxFrameBytes
      ) {
        return this.relayError(state, terminalId, 'Invalid terminal output frame');
      }
      if (sequence <= state.lastOutputSequence) return;
      if (sequence !== state.lastOutputSequence + 1n) {
        return this.relayError(state, terminalId, 'Terminal output gap requires reconnect');
      }
      state.lastOutputSequence = sequence;
      this.relayOutput(state, terminalId, state.outputDecoder.decode(data, { stream: true }));
      return;
    }
    if (frame.gap) {
      this.relayError(
        state,
        terminalId,
        `Terminal output history unavailable (earliest ${String(frame.gap.earliestAvailableSequence)})`,
      );
      return;
    }
    if (frame.failure) {
      this.relayError(state, terminalId, frame.failure.message || 'Terminal operation failed');
      return;
    }
    if (frame.close) {
      this.relayOutput(state, terminalId, state.outputDecoder.decode());
      this.relayToUser(state.userId, {
        type: 'pty:exit',
        threadId: '',
        data: { ptyId: terminalId, exitCode: frame.close.exitCode ?? null },
      });
      this.terminals.delete(this.key(runnerId, terminalId));
    }
  }

  private scheduleResizeFlush(): void {
    if (this.resizeFlushScheduled) return;
    this.resizeFlushScheduled = true;
    queueMicrotask(() => {
      this.resizeFlushScheduled = false;
      const pending = [...this.pendingResizes.entries()];
      this.pendingResizes.clear();
      for (const [key, resize] of pending) {
        const stream = this.streams.get(resize.runnerId);
        const state = this.terminals.get(key);
        if (!stream || !state) continue;
        const terminalId = key.slice(key.indexOf('\0') + 1);
        this.write(stream, terminalId, {
          resize: { columns: resize.columns, rows: resize.rows },
        });
      }
    });
  }

  private write(stream: ActiveTerminalStream, terminalId: string, frame: WireFrame): void {
    stream.call.write({
      session: { sessionEpoch: stream.epoch.toString() },
      terminalId,
      metadata: { correlationId: terminalId },
      ...frame,
    });
  }

  private relayError(state: TerminalState, terminalId: string, error: string): void {
    this.relayToUser(state.userId, {
      type: 'pty:error',
      threadId: '',
      data: { ptyId: terminalId, error },
    });
  }

  private relayOutput(state: TerminalState, terminalId: string, data: string): void {
    if (!data) return;
    this.relayToUser(state.userId, {
      type: 'pty:data',
      threadId: '',
      data: { ptyId: terminalId, data, sequence: state.lastOutputSequence },
    });
  }

  private runnerTerminalCount(runnerId: string): number {
    const prefix = `${runnerId}\0`;
    let count = 0;
    for (const key of this.terminals.keys()) if (key.startsWith(prefix)) count++;
    return count;
  }

  private key(runnerId: string, terminalId: string): string {
    return `${runnerId}\0${terminalId}`;
  }
}

export function createTerminalHandler(
  config: RunnerGrpcConfig,
  sessions: RunnerGrpcSessionRegistry,
  options: TerminalHandlerOptions = {},
): RunnerGrpcHandler {
  const terminals =
    options.dispatcher ??
    new RunnerGrpcTerminalDispatcher(config, sessions, options.relayToUser ?? (() => {}));
  return (call: RunnerGrpcCall, context: RunnerGrpcCallContext) => {
    let unregister: (() => void) | undefined;
    const close = () => unregister?.();
    call.once('cancelled', close);
    call.once('close', close);
    call.once('error', close);
    call.on('data', (request: WireFrame) => {
      const epoch = unsigned(request.session?.sessionEpoch) ?? 0n;
      if (!sessions.isActive(context.principal.runnerId, epoch)) {
        call.write({
          terminalId: request.terminalId ?? '',
          failure: {
            code: FailureCode.UNAVAILABLE,
            message: 'runner session is not active',
            retryable: true,
          },
        });
        return;
      }
      if (request.ready) {
        unregister?.();
        unregister = terminals.register(context.principal.runnerId, epoch, call);
        return;
      }
      terminals.receive(context.principal.runnerId, epoch, call, request);
    });
  };
}

export interface TerminalHandlerOptions {
  dispatcher?: RunnerGrpcTerminalDispatcher;
  relayToUser?: (userId: string, event: Record<string, unknown>) => void;
}
