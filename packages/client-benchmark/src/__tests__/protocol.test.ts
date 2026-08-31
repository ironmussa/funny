import { describe, expect, test } from 'bun:test';

import {
  BENCHMARK_PROTOCOL_VERSION,
  encodeBenchmarkMessage,
  parseBenchmarkCommand,
  parseBenchmarkEvent,
} from '../protocol';

describe('benchmark NDJSON protocol', () => {
  test('round-trips a workload command', () => {
    const command = {
      type: 'run-workload' as const,
      id: 'scroll-1',
      workload: 'scroll' as const,
      measured: true,
    };
    expect(parseBenchmarkCommand(encodeBenchmarkMessage(command).trim())).toEqual(command);
  });

  test('rejects unsupported protocol versions with an actionable label', () => {
    expect(() =>
      parseBenchmarkCommand(
        JSON.stringify({
          type: 'initialize',
          protocolVersion: BENCHMARK_PROTOCOL_VERSION + 1,
          runId: 'run-1',
          fixtureVersion: 'long-thread-v2',
        }),
      ),
    ).toThrow('Invalid benchmark command');
  });

  test('rejects malformed events and invalid JSON', () => {
    expect(() => parseBenchmarkEvent('{')).toThrow('Invalid benchmark event JSON');
    expect(() => parseBenchmarkEvent(JSON.stringify({ type: 'presented' }))).toThrow(
      'Invalid benchmark event',
    );
  });
});
