import { FailureCode } from '@funny/shared/runner-v2/common';

import type { RunnerGrpcWireMessage } from './grpc-runner-client.js';

export type RunnerControlCommandHandler = (
  command: RunnerGrpcWireMessage,
  signal: AbortSignal,
) => Promise<Record<string, unknown> | void>;

export interface RunnerControlSender {
  isActive(): boolean;
  sendControl(message: RunnerGrpcWireMessage): boolean;
}

/** Executes runner control commands and coordinates cancellation outcomes. */
export class RunnerControlDispatcher {
  private readonly commands = new Map<string, AbortController>();

  constructor(
    private readonly sender: RunnerControlSender,
    private readonly handler?: RunnerControlCommandHandler,
  ) {}

  receive(message: RunnerGrpcWireMessage): void {
    if (message.cancel) {
      const correlationId = String(message.cancel.correlationId ?? '');
      const controller = this.commands.get(correlationId);
      controller?.abort(message.cancel.reason ?? 'command cancelled');
      this.sender.sendControl({
        cancellationAcknowledgement: { correlationId, workStopped: Boolean(controller) },
      });
      return;
    }
    if (!message.command) return;

    const correlationId = String(message.command.metadata?.correlationId ?? '');
    if (!correlationId) return;
    if (!this.handler) {
      this.sender.sendControl({
        commandOutcome: {
          correlationId,
          failure: {
            code: FailureCode.UNAVAILABLE,
            message: 'runner control handler is unavailable',
            retryable: false,
          },
        },
      });
      return;
    }

    const controller = new AbortController();
    this.commands.set(correlationId, controller);
    void this.handler(message.command, controller.signal)
      .then((result) => {
        if (!this.sender.isActive()) return;
        this.sender.sendControl({
          commandOutcome: { correlationId, success: result ?? {} },
        });
      })
      .catch((error) => {
        if (!this.sender.isActive()) return;
        const cancelled = controller.signal.aborted;
        this.sender.sendControl({
          commandOutcome: {
            correlationId,
            failure: {
              code: cancelled ? FailureCode.CANCELLED : FailureCode.INTERNAL,
              message: cancelled ? 'runner command cancelled' : String((error as Error).message),
              retryable: false,
            },
          },
        });
      })
      .finally(() => this.commands.delete(correlationId));
  }

  shutdown(reason = 'gRPC transport shut down'): void {
    for (const controller of this.commands.values()) controller.abort(reason);
    this.commands.clear();
  }
}
