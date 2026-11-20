import { TERMINAL_SESSION_UNAVAILABLE } from '@funny/shared/socket-events';
import { describe, expect, test, vi } from 'vitest';

import { GrpcTerminalReplayStore } from '../../services/grpc-terminal-replay-store.js';
import { RunnerTerminalAdapter } from '../../services/runner-terminal-adapter.js';

describe('RunnerTerminalAdapter', () => {
  test('maps open/input commands and sequences chunked output', () => {
    const send = vi.fn((_name: 'terminal', _message: Record<string, any>) => true);
    const handle = vi.fn();
    let outputSequence = 0n;
    const store = new GrpcTerminalReplayStore();
    vi.spyOn(store, 'acceptInput').mockReturnValue(true);
    vi.spyOn(store, 'append').mockImplementation((_terminalId, data) => ({
      sequence: ++outputSequence,
      data,
    }));
    vi.spyOn(store, 'replay').mockReturnValue({ kind: 'replay', outputs: [], latestSequence: 0n });
    vi.spyOn(store, 'close').mockReturnValue(true);
    const adapter = new RunnerTerminalAdapter({ send }, store, handle);
    adapter.setMaxFrameBytes(3);

    adapter.receive({
      terminalId: 'pty-1',
      open: { userId: 'user-1', cwd: '/repo', columns: 80, rows: 24 },
    });
    adapter.receive({
      terminalId: 'pty-1',
      input: { ordinal: '1', data: Buffer.from('ls').toString('base64') },
    });
    expect(handle).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ type: 'pty:write', userId: 'user-1' }),
      expect.any(Function),
    );

    adapter.publish({ type: 'pty:data', threadId: '', data: { ptyId: 'pty-1', data: 'hello' } });
    const outputFrames = send.mock.calls.filter(([, message]) => message.output);
    expect(outputFrames).toHaveLength(2);
    expect(outputFrames.map(([, message]) => message.output.sequence)).toEqual(['1', '2']);
  });

  test('emits a replay gap before restore when history was pruned', () => {
    const send = vi.fn((_name: 'terminal', _message: Record<string, any>) => true);
    const handle = vi.fn();
    const store = new GrpcTerminalReplayStore();
    vi.spyOn(store, 'acceptInput').mockReturnValue(true);
    vi.spyOn(store, 'append');
    vi.spyOn(store, 'replay').mockReturnValue({
      kind: 'gap',
      earliestAvailableSequence: 7n,
      latestSequence: 7n,
    });
    vi.spyOn(store, 'close').mockReturnValue(true);
    const adapter = new RunnerTerminalAdapter({ send }, store, handle);
    adapter.receive({ terminalId: 'pty-1', open: { userId: 'user-1' } });
    adapter.receive({ terminalId: 'pty-1', resume: { lastSeenOutputSequence: '2' } });

    expect(send).toHaveBeenCalledWith('terminal', {
      terminalId: 'pty-1',
      gap: { requestedSequence: '3', earliestAvailableSequence: '7' },
    });
  });

  test('replay-only resume replays lost output without a screen snapshot', () => {
    const send = vi.fn((_name: 'terminal', _message: Record<string, any>) => true);
    const handle = vi.fn();
    const store = new GrpcTerminalReplayStore();
    vi.spyOn(store, 'acceptInput').mockReturnValue(true);
    vi.spyOn(store, 'append');
    vi.spyOn(store, 'replay').mockReturnValue({
      kind: 'replay',
      outputs: [{ sequence: 3n, data: Uint8Array.from([111, 107]) }],
      latestSequence: 3n,
    });
    vi.spyOn(store, 'close').mockReturnValue(true);
    const adapter = new RunnerTerminalAdapter({ send }, store, handle);
    adapter.receive({ terminalId: 'pty-1', open: { userId: 'user-1' } });
    handle.mockClear();

    adapter.receive({
      terminalId: 'pty-1',
      resume: { lastSeenOutputSequence: '2', replayOnly: true },
    });
    expect(send).toHaveBeenCalledWith('terminal', {
      terminalId: 'pty-1',
      output: { sequence: '3', data: Buffer.from('ok').toString('base64') },
    });
    expect(handle).not.toHaveBeenCalled();

    adapter.receive({ terminalId: 'pty-1', resume: { lastSeenOutputSequence: '2' } });
    expect(handle).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'pty:restore' }),
      expect.any(Function),
    );
  });

  test('reports an unknown terminal as unavailable instead of dropping the command', () => {
    // A runner restart forgets which user opened each terminal while the shell
    // lives on in the PTY daemon. Input for it used to vanish silently.
    const send = vi.fn((_name: 'terminal', _message: Record<string, any>) => true);
    const handle = vi.fn();
    const adapter = new RunnerTerminalAdapter({ send }, undefined, handle);

    adapter.receive({
      terminalId: 'pty-1',
      input: { ordinal: '1', data: Buffer.from('ls').toString('base64') },
    });
    adapter.receive({ terminalId: 'pty-1', close: { reason: 'pty:close' } });

    expect(handle).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('terminal', {
      terminalId: 'pty-1',
      failure: expect.objectContaining({ message: TERMINAL_SESSION_UNAVAILABLE, retryable: true }),
    });
  });
});
