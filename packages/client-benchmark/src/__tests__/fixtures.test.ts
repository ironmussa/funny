import { describe, expect, test } from 'bun:test';

import {
  makeLongThread,
  makeRendererBenchmarkFixtures,
  benchmarkStateChecksum,
  RENDERER_BENCHMARK_FIXTURE_VERSION,
} from '../fixtures/long-thread-fixture';

describe('renderer benchmark fixtures', () => {
  test('preserves the deterministic legacy fixture generator', () => {
    const first = makeLongThread({ messageCount: 60, seed: 7 });
    const second = makeLongThread({ messageCount: 60, seed: 7 });
    const different = makeLongThread({ messageCount: 60, seed: 8 });

    expect(first).toEqual(second);
    expect(first).not.toEqual(different);
  });

  test('creates two immutable-version 500-message fixtures with required features', () => {
    const fixtures = makeRendererBenchmarkFixtures();
    const repeated = makeRendererBenchmarkFixtures();

    expect(fixtures.fixtureVersion).toBe(RENDERER_BENCHMARK_FIXTURE_VERSION);
    expect(fixtures.a.counts.messages).toBe(500);
    expect(fixtures.b.counts.messages).toBe(500);
    expect(fixtures.a.featureInventory.markdown).toBe(250);
    expect(fixtures.a.featureInventory.code).toBeGreaterThan(0);
    expect(fixtures.a.featureInventory.table).toBeGreaterThan(0);
    expect(fixtures.a.featureInventory.toolCall).toBeGreaterThan(0);
    expect(fixtures.a.featureInventory.diff).toBe(1);
    expect(fixtures.a.checksum).toBe(repeated.a.checksum);
    expect(fixtures.a.checksum).not.toBe(fixtures.b.checksum);
    expect(
      benchmarkStateChecksum(fixtures, {
        fixtureKey: 'a',
        streamRevision: 0,
        inputRevision: 0,
      }),
    ).not.toBe(
      benchmarkStateChecksum(fixtures, {
        fixtureKey: 'b',
        streamRevision: 0,
        inputRevision: 0,
      }),
    );
  });
});
