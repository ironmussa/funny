import type { DescMethodStreaming } from '@bufbuild/protobuf';
import { RunnerTransportService } from '@funny/shared/runner-v2/control';
import { describe, expect, test } from 'vitest';

import { grpcMethodDefinition } from '../../services/grpc-runner-client.js';

describe('runner gRPC event serialization', () => {
  test('round-trips clone progress without a percentage through the real protobuf codec', () => {
    const method = RunnerTransportService.methods.find((entry) => entry.localName === 'events');
    const codec = grpcMethodDefinition(method as DescMethodStreaming);
    const data = {
      cloneId: 'clone:123',
      phase: 'Cloning into repository...',
      percent: undefined,
      details: { optional: undefined, nullable: null },
    };
    const decoded = codec.requestDeserialize(
      codec.requestSerialize({
        sequence: '1',
        event: { eventType: 'clone:progress', data },
      }),
    );
    expect(decoded.event.data).toEqual({
      cloneId: 'clone:123',
      phase: 'Cloning into repository...',
      details: { nullable: null },
    });
    expect(data).toHaveProperty('percent', undefined);

    const withPercent = codec.requestDeserialize(
      codec.requestSerialize({
        sequence: '2',
        event: { eventType: 'clone:progress', data: { ...data, percent: 0 } },
      }),
    );
    expect(withPercent.event.data.percent).toBe(0);
  });
});
