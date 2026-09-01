export interface GrpcTerminalOutput {
  sequence: bigint;
  data: Uint8Array;
}

export type GrpcTerminalReplay =
  | { kind: 'replay'; outputs: GrpcTerminalOutput[]; latestSequence: bigint }
  | { kind: 'gap'; earliestAvailableSequence: bigint; latestSequence: bigint };

interface TerminalHistory {
  nextSequence: bigint;
  lastInputOrdinal: bigint;
  byteLength: number;
  outputs: GrpcTerminalOutput[];
}

/**
 * Bounded, process-local terminal output history. Terminal output can be
 * replayed after a transport reconnect, while terminal input is intentionally
 * absent from this store and therefore can never be replayed implicitly.
 */
export class GrpcTerminalReplayStore {
  private readonly histories = new Map<string, TerminalHistory>();

  constructor(
    private readonly maxFramesPerTerminal = 1_000,
    private readonly maxBytesPerTerminal = 1024 * 1024,
    private readonly maxFrameBytes = 64 * 1024,
  ) {
    if (!Number.isSafeInteger(maxFramesPerTerminal) || maxFramesPerTerminal <= 0) {
      throw new Error('terminal replay frame limit must be positive');
    }
    if (!Number.isSafeInteger(maxBytesPerTerminal) || maxBytesPerTerminal <= 0) {
      throw new Error('terminal replay byte limit must be positive');
    }
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes <= 0) {
      throw new Error('terminal output frame limit must be positive');
    }
    if (maxFrameBytes > maxBytesPerTerminal) {
      throw new Error('terminal output frame limit must not exceed replay byte limit');
    }
  }

  append(terminalId: string, data: Uint8Array): GrpcTerminalOutput {
    if (!terminalId) throw new Error('terminal ID is required');
    if (!(data instanceof Uint8Array)) throw new Error('terminal output must be binary');
    if (data.byteLength > this.maxFrameBytes) {
      throw new Error('terminal output exceeds the configured frame limit');
    }
    const history = this.histories.get(terminalId) ?? {
      nextSequence: 1n,
      lastInputOrdinal: 0n,
      byteLength: 0,
      outputs: [],
    };
    this.histories.set(terminalId, history);
    // Copy the view because PTY adapters commonly reuse their read buffers.
    const output = { sequence: history.nextSequence, data: Uint8Array.from(data) };
    history.nextSequence += 1n;
    history.outputs.push(output);
    history.byteLength += output.data.byteLength;
    while (
      history.outputs.length > this.maxFramesPerTerminal ||
      history.byteLength > this.maxBytesPerTerminal
    ) {
      const removed = history.outputs.shift();
      if (removed) history.byteLength -= removed.data.byteLength;
    }
    return output;
  }

  /**
   * Accepts an input ordinal at most once for the lifetime of this terminal.
   * Only the ordinal is retained: input bytes must be applied by the caller
   * immediately and are deliberately never available for replay.
   */
  acceptInput(terminalId: string, ordinal: bigint): boolean {
    if (!terminalId) throw new Error('terminal ID is required');
    if (ordinal <= 0n) throw new Error('terminal input ordinal must be positive');
    const history = this.histories.get(terminalId) ?? {
      nextSequence: 1n,
      lastInputOrdinal: 0n,
      byteLength: 0,
      outputs: [],
    };
    this.histories.set(terminalId, history);
    if (ordinal <= history.lastInputOrdinal) return false;
    history.lastInputOrdinal = ordinal;
    return true;
  }

  replay(terminalId: string, afterSequence: bigint): GrpcTerminalReplay {
    if (!terminalId) throw new Error('terminal ID is required');
    if (afterSequence < 0n) throw new Error('terminal replay sequence must not be negative');
    const history = this.histories.get(terminalId);
    if (!history) return { kind: 'replay', outputs: [], latestSequence: 0n };
    const latestSequence = history.nextSequence - 1n;
    const earliestAvailableSequence = history.outputs[0]?.sequence ?? history.nextSequence;
    if (afterSequence + 1n < earliestAvailableSequence) {
      return { kind: 'gap', earliestAvailableSequence, latestSequence };
    }
    return {
      kind: 'replay',
      outputs: history.outputs.filter((output) => output.sequence > afterSequence),
      latestSequence,
    };
  }

  close(terminalId: string): boolean {
    return this.histories.delete(terminalId);
  }
}
