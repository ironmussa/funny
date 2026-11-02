import type { WSEvent } from '@funny/shared';
import { FailureCode } from '@funny/shared/runner-v2/common';

import type { RunnerGrpcWireMessage } from './grpc-runner-client.js';
import { GrpcTerminalReplayStore } from './grpc-terminal-replay-store.js';
import { binary, unsigned } from './grpc-wire-values.js';

export interface GrpcTerminalCommand {
  terminalId: string;
  userId?: string;
  type: 'pty:spawn' | 'pty:write' | 'pty:resize' | 'pty:kill' | 'pty:signal' | 'pty:restore';
  data: Record<string, any>;
}

export interface RunnerTerminalSender {
  send(name: 'terminal', message: RunnerGrpcWireMessage): boolean;
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
    const command = message.open
      ? this.openCommand(terminalId, message.open)
      : this.sessionCommand(terminalId, message);
    if (command) this.handle(command, (event) => this.publish(event));
  }

  private openCommand(
    terminalId: string,
    open: RunnerGrpcWireMessage,
  ): GrpcTerminalCommand | undefined {
    const userId = String(open.userId ?? '');
    if (!userId) return undefined;
    this.users.set(terminalId, userId);
    return {
      terminalId,
      userId,
      type: 'pty:spawn',
      data: {
        id: terminalId,
        cwd: open.cwd,
        cols: open.columns,
        rows: open.rows,
        shell: open.shell,
        projectId: open.projectId,
        label: open.label,
        scratchThreadId: open.scratchThreadId,
      },
    };
  }

  /** Commands for an already-open terminal, owned by the user that opened it. */
  private sessionCommand(
    terminalId: string,
    message: RunnerGrpcWireMessage,
  ): GrpcTerminalCommand | undefined {
    const userId = this.users.get(terminalId);
    if (!userId) return undefined;
    if (message.input) return this.inputCommand(terminalId, userId, message.input);
    if (message.resize) {
      const { columns: cols, rows } = message.resize;
      return { terminalId, userId, type: 'pty:resize', data: { id: terminalId, cols, rows } };
    }
    if (message.signal) {
      const { signal } = message.signal;
      return { terminalId, userId, type: 'pty:signal', data: { id: terminalId, signal } };
    }
    if (message.close) return { terminalId, userId, type: 'pty:kill', data: { id: terminalId } };
    if (message.resume) return this.resumeCommand(terminalId, userId, message.resume);
    return undefined;
  }

  private inputCommand(
    terminalId: string,
    userId: string,
    input: RunnerGrpcWireMessage,
  ): GrpcTerminalCommand | undefined {
    const ordinal = unsigned(input.ordinal);
    const data = binary(input.data);
    if (!ordinal || !data || !this.store.acceptInput(terminalId, ordinal)) return undefined;
    return {
      terminalId,
      userId,
      type: 'pty:write',
      data: { id: terminalId, data: new TextDecoder().decode(data) },
    };
  }

  /** Replays buffered output; a full resume also restores the screen snapshot. */
  private resumeCommand(
    terminalId: string,
    userId: string,
    resume: RunnerGrpcWireMessage,
  ): GrpcTerminalCommand | undefined {
    const after = unsigned(resume.lastSeenOutputSequence) ?? 0n;
    const replay = this.store.replay(terminalId, after);
    if (replay.kind === 'gap') {
      this.sender.send('terminal', {
        terminalId,
        gap: {
          requestedSequence: String(after + 1n),
          earliestAvailableSequence: String(replay.earliestAvailableSequence),
        },
      });
      return undefined;
    }
    for (const output of replay.outputs) this.sendOutput(terminalId, output);
    // Server-initiated recovery of lost frames: the browser already shows
    // everything before them, so a screen snapshot would duplicate content.
    if (resume.replayOnly === true) return undefined;
    return { terminalId, userId, type: 'pty:restore', data: { id: terminalId } };
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
