import { describe, expect, test } from 'bun:test';

import { getTelemetryIdentity } from '../lib/telemetry-identity';

describe('telemetry emitter identity', () => {
  test('reuses the identity across clients for the same emitter', () => {
    const identity = getTelemetryIdentity('funny-client');
    expect(getTelemetryIdentity('funny-client')).toBe(identity);
    expect(identity.instanceId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('distinguishes client, server and runtime emitters', () => {
    const identities = ['funny-client', 'funny-server', 'funny-runtime'].map((source) =>
      getTelemetryIdentity(source as Parameters<typeof getTelemetryIdentity>[0]),
    );
    expect(new Set(identities.map(({ instanceId }) => instanceId)).size).toBe(3);
  });
});
