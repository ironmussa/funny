import type { WSEvent } from '@funny/shared';

import { GrpcEventReplayStore } from './grpc-event-replay-store.js';
import { GrpcOperationOutbox } from './grpc-operation-outbox.js';
import { GrpcOperationsAdapter } from './grpc-operations-adapter.js';
import {
  RunnerGrpcClient,
  type RunnerGrpcClientOptions,
  type RunnerGrpcStreamName,
  type RunnerGrpcWireMessage,
} from './grpc-runner-client.js';
import { GrpcTerminalReplayStore } from './grpc-terminal-replay-store.js';
import {
  RunnerControlDispatcher,
  type RunnerControlCommandHandler as GrpcControlCommandHandler,
} from './runner-control-dispatcher.js';
import { RunnerEventPublisher } from './runner-event-publisher.js';
import { RunnerTerminalAdapter, type GrpcTerminalCommand } from './runner-terminal-adapter.js';
import { RunnerTunnelAdapter } from './runner-tunnel-adapter.js';

export type { GrpcTerminalCommand };

export type { GrpcControlCommandHandler };

/** Adapts the existing team-client API to one negotiated runner.v2 session. */
export class GrpcTeamTransport {
  readonly client: RunnerGrpcClient;
  private readonly operations: GrpcOperationsAdapter;
  private readonly events: RunnerEventPublisher;
  private readonly terminal: RunnerTerminalAdapter;
  private readonly tunnel: RunnerTunnelAdapter;
  private readonly control: RunnerControlDispatcher;
  private shutdownComplete = false;

  constructor(
    options: RunnerGrpcClientOptions & {
      outbox?: GrpcOperationOutbox;
      events?: GrpcEventReplayStore;
      terminals?: GrpcTerminalReplayStore;
      handleTunnel?: (request: Request, signal: AbortSignal) => Promise<Response>;
      handleTerminal?: (command: GrpcTerminalCommand, respond: (event: WSEvent) => void) => void;
      handleControl?: GrpcControlCommandHandler;
      onControl?: (message: RunnerGrpcWireMessage) => void;
      onStreamMessage?: (name: RunnerGrpcStreamName, message: RunnerGrpcWireMessage) => void;
    },
  ) {
    this.events = new RunnerEventPublisher(
      { send: (_name, message) => this.client.send('events', message) },
      options.events ?? new GrpcEventReplayStore(),
    );
    const onActivated = options.onActivated;
    const onDisconnected = options.onDisconnected;
    this.operations = new GrpcOperationsAdapter(
      { send: (_name, message) => this.client.send('operations', message) },
      options.outbox ?? new GrpcOperationOutbox(),
    );
    this.control = new RunnerControlDispatcher(
      {
        sendControl: (message) => this.client.sendControl(message),
        isActive: () => this.client.isActive(),
      },
      options.handleControl,
    );
    this.tunnel = new RunnerTunnelAdapter(
      { send: (_name, message) => this.client.send('tunnel', message) },
      options.handleTunnel,
    );
    this.terminal = new RunnerTerminalAdapter(
      { send: (_name, message) => this.client.send('terminal', message) },
      options.terminals ?? new GrpcTerminalReplayStore(),
      options.handleTerminal,
    );
    this.client = new RunnerGrpcClient({
      ...options,
      eventCursors: this.events.resumeCursors(),
      onActivated: (hello) => {
        const negotiatedFrameBytes = Number(hello.effectiveLimits?.maxFrameBytes);
        if (Number.isSafeInteger(negotiatedFrameBytes) && negotiatedFrameBytes > 0) {
          this.tunnel.setMaxFrameBytes(negotiatedFrameBytes);
          this.terminal.setMaxFrameBytes(negotiatedFrameBytes);
        }
        this.operations.activated();
        this.events.activated();
        onActivated?.(hello);
      },
      onDisconnected: (error) => onDisconnected?.(error),
      onControl: (message) => {
        this.control.receive(message);
        options.onControl?.(message);
      },
      onStreamMessage: (name, message) => {
        if (name === 'operations') this.operations.receive(message);
        else if (name === 'events') this.events.receiveReceipt(message);
        else if (name === 'tunnel') this.tunnel.receive(message);
        else if (name === 'terminal') this.terminal.receive(message);
        options.onStreamMessage?.(name, message);
      },
    });
  }

  start(): void {
    this.client.start();
  }

  shutdown(reason?: string): void {
    if (this.shutdownComplete) return;
    this.shutdownComplete = true;
    this.client.shutdown(reason);
    this.operations.shutdown();
    this.tunnel.shutdown();
    this.terminal.shutdown();
    this.control.shutdown();
    this.events.shutdown();
  }

  request(eventType: string, input: Record<string, any>): Promise<any> {
    return this.operations.request(eventType, input);
  }

  publish(event: WSEvent): void {
    if (event.type.startsWith('pty:')) {
      this.terminal.publish(event);
      return;
    }
    this.events.publish(event);
  }
}
