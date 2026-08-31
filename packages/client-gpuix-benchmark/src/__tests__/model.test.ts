import { describe, expect, test } from 'bun:test';

import { makeRendererBenchmarkFixtures } from '@funny/client-benchmark';

import { buildGpuixRows, gpuixFinalStateChecksum } from '../model';

describe('GPUIX renderer model', () => {
  test('maps every fixture message and native feature payload', () => {
    const fixtures = makeRendererBenchmarkFixtures();
    const rows = buildGpuixRows(fixtures.a, 0);
    expect(rows).toHaveLength(500);
    expect(rows.filter((row) => row.diffPatch !== null)).toHaveLength(1);
    expect(rows.flatMap((row) => row.toolCalls)).toHaveLength(fixtures.a.counts.toolCalls);
    expect(rows.some((row) => row.markdown.includes('| Area | Current | Candidate |'))).toBe(true);
    expect(rows.some((row) => row.markdown.includes('```ts'))).toBe(true);
  });

  test('tracks streaming state in content and final checksum', () => {
    const fixtures = makeRendererBenchmarkFixtures();
    const before = gpuixFinalStateChecksum(fixtures, {
      fixtureKey: 'a',
      streamRevision: 0,
      inputRevision: 0,
    });
    const after = gpuixFinalStateChecksum(fixtures, {
      fixtureKey: 'a',
      streamRevision: 1,
      inputRevision: 0,
    });
    expect(buildGpuixRows(fixtures.a, 1).at(-1)?.markdown).toContain('stream revision 1');
    expect(after).not.toBe(before);
  });
});
