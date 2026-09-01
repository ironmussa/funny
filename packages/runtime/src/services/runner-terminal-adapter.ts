import type { WSEvent } from '@funny/shared';
import { FailureCode } from '@funny/shared/runner-v2/common';

import type { RunnerGrpcWireMessage } from './grpc-runner-client.js';
import { GrpcTerminalReplayStore } from './grpc-terminal-replay-store.js';

export interface GrpcTerminalCommand {
  terminalId: string;
  userId?: string;
  type: 'pty:spawn' | 'pty:write' | 'pty:resize' | 'pty:kill' | 'pty:signal' | 'pty:restore';
  data: Record<string, any>;
}

export interface RunnerTerminalSender {
  send(name: 'terminal', message: RunnerGrpcWireMessage): boolean;
}

function binary(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (typeof value !== 'string') return null;
  try {
    return Buffer.from(value, 'base64');
  } catch {
    return null;
  }
}

function unsigned(value: unknown): bigint | null {
  try {
    const parsed = BigInt(value as string | number | bigint);
    return parsed >= 0n ? parsed : null;
  } catch {
    return null;
  }
}

/** Maps terminal commands, output sequence/replay, and terminal outcomes. */
export class RunnerTerminalAdapter {
  private readonly users = new Map<string, string>();
  private maxFrameBytes = 64 * 1024;

  constructor(
    private readonly sender: RunnerTerminalSender,
    private readonly store: GrpcTerminalReplayStore = new GrpcTerminalReplayStore(),
    private readonly handle?: (
      command: GrpcTerminalCommand,
      respond: (event: WSEvent) => void,
    ) => void,
  ) {}

  setMaxFrameBytes(value: number): void {
    if (Number.isSafeInteger(value) && value > 0) this.maxFrameBytes = value;
  }

  receive(message: RunnerGrpcWireMessage): void {
    const terminalId = String(message.terminalId ?? '');
    if (!terminalId || !this.handle) return;
    let command: GrpcTerminalCommand | undefined;
    if (message.open) {
      const userId = String(message.open.userId ?? '');
      if (!userId) return;
      this.users.set(terminalId, userId);
      command = {
        terminalId,
        userId,
        type: 'pty:spawn',
        data: {
          id: terminalId,
          cwd: message.open.cwd,
          cols: message.open.columns,
          rows: message.open.rows,
          shell: message.open.shell,
          projectId: message.open.projectId,
          label: message.open.label,
        },
      };
    } else {
      const userId = this.users.get(terminalId);
      if (!userId) return;
      if (message.input) {
        const ordinal = unsigned(message.input.ordinal);
        const data = binary(message.input.data);
        if (!ordinal || !data || !this.store.acceptInput(terminalId, ordinal)) return;
        command = {
          terminalId,
          userId,
          type: 'pty:write',
          data: { id: terminalId, data: new TextDecoder().decode(data) },
        };
      } else if (message.resize) {
        command = {
          terminalId,
          userId,
          type: 'pty:resize',
          data: {
            id: terminalId,
            cols: message.resize.columns,
            rows: message.resize.rows,
          },
        };
      } else if (message.signal) {
        command = {
          terminalId,
          userId,
          type: 'pty:signal',
          data: {
            id: terminalId,
            signal: message.signal.signal,
          },
        };
      } else if (message.close) {
        command = { terminalId, userId, type: 'pty:kill', data: { id: terminalId } };
      } else if (message.resume) {
        const after = unsigned(message.resume.lastSeenOutputSequence) ?? 0n;
        const replay = this.store.replay(terminalId, after);
        if (replay.kind === 'gap') {
          this.sender.send('terminal', {
            terminalId,
            gap: {
              requestedSequence: String(after + 1n),
              earliestAvailableSequence: String(replay.earliestAvailableSequence),
            },
          });
          return;
        }
        for (const output of replay.outputs) this.sendOutput(terminalId, output);
        command = { terminalId, userId, type: 'pty:restore', data: { id: terminalId } };
      }
    }
    if (command) this.handle(command, (event) => this.publish(event));
  }

  publish(event: WSEvent): void {
    const data = event.data as Record<string, any>;
    const terminalId = String(data?.ptyId ?? '');
    if (!terminalId) return;
    if (event.type === 'pty:data') {
      const bytes =
        data.data instanceof Uint8Array ? data.data : Buffer.from(String(data.data ?? ''), 'utf8');
      for (let offset = 0; offset < bytes.byteLength; offset += this.maxFrameBytes) {
        const output = this.store.append(
          terminalId,
          bytes.subarray(offset, Math.min(offset + this.maxFrameBytes, bytes.byteLength)),
        );
        this.sendOutput(terminalId, output);
      }
      return;
    }
    if (event.type === 'pty:exit') {
      this.sender.send('terminal', {
        terminalId,
        close: { exitCode: data.exitCode ?? 0, reason: 'terminal exited' },
      });
      this.users.delete(terminalId);
      this.store.close(terminalId);
      return;
    }
    if (event.type === 'pty:error') {
      this.sender.send('terminal', {
        terminalId,
        failure: {
          code: FailureCode.INTERNAL,
          message: String(data.error ?? 'terminal failed'),
          retryable: false,
        },
      });
    }
  }

  shutdown(): void {
    this.users.clear();
  }

  private sendOutput(terminalId: string, output: { sequence: bigint; data: Uint8Array }): void {
    this.sender.send('terminal', {
      terminalId,
      output: {
        sequence: String(output.sequence),
        data: Buffer.from(output.data).toString('base64'),
      },
    });
  }
}
