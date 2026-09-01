import { describe, expect, test, vi } from 'vitest';

import { RunnerTerminalAdapter } from '../../services/runner-terminal-adapter.js';

describe('RunnerTerminalAdapter', () => {
  test('maps open/input commands and sequences chunked output', () => {
    const send = vi.fn((_name: 'terminal', _message: Record<string, any>) => true);
    const handle = vi.fn();
    let outputSequence = 0n;
    const store = {
      acceptInput: vi.fn(() => true),
      append: (_terminalId: string, data: Uint8Array) => ({ sequence: ++outputSequence, data }),
      replay: () => ({ kind: 'ok', outputs: [] }),
      close: vi.fn(),
    };
    const adapter = new RunnerTerminalAdapter({ send }, store as any, handle);
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

    adapter.publish({ type: 'pty:data', data: { ptyId: 'pty-1', data: 'hello' } } as any);
    const outputFrames = send.mock.calls.filter(([, message]) => message.output);
    expect(outputFrames).toHaveLength(2);
    expect(outputFrames.map(([, message]) => message.output.sequence)).toEqual(['1', '2']);
  });

  test('emits a replay gap before restore when history was pruned', () => {
    const send = vi.fn((_name: 'terminal', _message: Record<string, any>) => true);
    const handle = vi.fn();
    const store = {
      acceptInput: () => true,
      append: vi.fn(),
      replay: () => ({ kind: 'gap', earliestAvailableSequence: 7n }),
      close: vi.fn(),
    };
    const adapter = new RunnerTerminalAdapter({ send }, store as any, handle);
    adapter.receive({ terminalId: 'pty-1', open: { userId: 'user-1' } });
    adapter.receive({ terminalId: 'pty-1', resume: { lastSeenOutputSequence: '2' } });

    expect(send).toHaveBeenCalledWith('terminal', {
      terminalId: 'pty-1',
      gap: { requestedSequence: '3', earliestAvailableSequence: '7' },
    });
  });
});
