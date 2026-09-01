import type { DetailedProcessTreeSample } from '../renderer-benchmark/process-sampler';

export type SoakPhaseName =
  | 'idle'
  | 'thread'
  | 'browser-open'
  | 'browser-closed'
  | 'terminal-open'
  | 'terminal-closed';

export interface ClientMemorySample {
  timestampMs: number;
  phase: SoakPhaseName;
  process: DetailedProcessTreeSample | null;
  heap: { usedBytes: number; totalBytes: number } | null;
  dom: { documents: number; nodes: number; listeners: number } | null;
  profiler: { sessionId: string | null; workersLive: number | null } | null;
}

export interface PhaseSummary {
  phase: SoakPhaseName;
  samples: number;
  durationMs: number;
  rssInitialBytes: number | null;
  rssFinalBytes: number | null;
  rssPeakBytes: number | null;
  rssGrowthBytes: number | null;
  rssSlopeBytesPerMinute: number | null;
  heapGrowthBytes: number | null;
  domNodeGrowth: number | null;
}

export type SoakVerdict = 'stable' | 'suspicious' | 'native-retention-likely' | 'inconclusive';

export interface SoakAnalysis {
  verdict: SoakVerdict;
  reason: string;
  phases: PhaseSummary[];
  rssRecoveryAfterBrowserBytes: number | null;
  rssRecoveryAfterTerminalBytes: number | null;
}

const MIB = 1024 * 1024;

function growth(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  return values.at(-1)! - values[0]!;
}

function slope(samples: readonly { timestampMs: number; value: number }[]): number | null {
  if (samples.length < 2) return null;
  const origin = samples[0]!.timestampMs;
  const points = samples.map((sample) => ({
    x: (sample.timestampMs - origin) / 60_000,
    y: sample.value,
  }));
  const meanX = points.reduce((total, point) => total + point.x, 0) / points.length;
  const meanY = points.reduce((total, point) => total + point.y, 0) / points.length;
  const numerator = points.reduce(
    (total, point) => total + (point.x - meanX) * (point.y - meanY),
    0,
  );
  const denominator = points.reduce((total, point) => total + (point.x - meanX) ** 2, 0);
  return denominator === 0 ? null : numerator / denominator;
}

function summarizePhase(
  phase: SoakPhaseName,
  samples: readonly ClientMemorySample[],
): PhaseSummary {
  const phaseSamples = samples.filter((sample) => sample.phase === phase);
  const rss = phaseSamples.flatMap((sample) =>
    sample.process
      ? [{ timestampMs: sample.timestampMs, value: sample.process.chromiumRssBytes }]
      : [],
  );
  const heap = phaseSamples.flatMap((sample) => (sample.heap ? [sample.heap.usedBytes] : []));
  const dom = phaseSamples.flatMap((sample) => (sample.dom ? [sample.dom.nodes] : []));
  return {
    phase,
    samples: phaseSamples.length,
    durationMs:
      phaseSamples.length < 2 ? 0 : phaseSamples.at(-1)!.timestampMs - phaseSamples[0]!.timestampMs,
    rssInitialBytes: rss[0]?.value ?? null,
    rssFinalBytes: rss.at(-1)?.value ?? null,
    rssPeakBytes: rss.length > 0 ? Math.max(...rss.map((sample) => sample.value)) : null,
    rssGrowthBytes: growth(rss.map((sample) => sample.value)),
    rssSlopeBytesPerMinute: slope(rss),
    heapGrowthBytes: growth(heap),
    domNodeGrowth: growth(dom),
  };
}

function recovery(open: PhaseSummary | undefined, closed: PhaseSummary | undefined): number | null {
  if (open?.rssFinalBytes === null || closed?.rssFinalBytes === null) return null;
  if (open?.rssFinalBytes === undefined || closed?.rssFinalBytes === undefined) return null;
  return open.rssFinalBytes - closed.rssFinalBytes;
}

export function analyzeClientMemorySoak(samples: readonly ClientMemorySample[]): SoakAnalysis {
  const order: SoakPhaseName[] = [
    'idle',
    'thread',
    'browser-open',
    'browser-closed',
    'terminal-open',
    'terminal-closed',
  ];
  const phases = order
    .filter((phase) => samples.some((sample) => sample.phase === phase))
    .map((phase) => summarizePhase(phase, samples));
  const longEnough = phases.filter((phase) => phase.samples >= 6 && phase.durationMs >= 5 * 60_000);
  const browserRecovery = recovery(
    phases.find((phase) => phase.phase === 'browser-open'),
    phases.find((phase) => phase.phase === 'browser-closed'),
  );
  const terminalRecovery = recovery(
    phases.find((phase) => phase.phase === 'terminal-open'),
    phases.find((phase) => phase.phase === 'terminal-closed'),
  );

  let verdict: SoakVerdict = 'inconclusive';
  let reason = 'The run needs at least six samples and five minutes in a measured phase.';
  if (longEnough.length > 0) {
    const nativePhase = longEnough.find(
      (phase) =>
        (phase.rssGrowthBytes ?? 0) > 128 * MIB &&
        Math.abs(phase.heapGrowthBytes ?? Number.POSITIVE_INFINITY) < 32 * MIB,
    );
    const suspiciousPhase = longEnough.find((phase) => (phase.rssGrowthBytes ?? 0) > 64 * MIB);
    if (nativePhase) {
      verdict = 'native-retention-likely';
      reason = `${nativePhase.phase} RSS grew by more than 128 MiB while its JavaScript heap stayed within 32 MiB.`;
    } else if (suspiciousPhase) {
      verdict = 'suspicious';
      reason = `${suspiciousPhase.phase} RSS grew by more than 64 MiB during the measured phase.`;
    } else {
      verdict = 'stable';
      reason = 'RSS growth stayed within 64 MiB in every sufficiently long measured phase.';
    }
  }

  return {
    verdict,
    reason,
    phases,
    rssRecoveryAfterBrowserBytes: browserRecovery,
    rssRecoveryAfterTerminalBytes: terminalRecovery,
  };
}

function mib(value: number | null): string {
  return value === null ? 'n/a' : `${(value / MIB).toFixed(1)} MiB`;
}

export function renderClientMemoryReport(analysis: SoakAnalysis): string {
  const rows = analysis.phases.map(
    (phase) =>
      `| ${phase.phase} | ${phase.samples} | ${mib(phase.rssInitialBytes)} | ${mib(phase.rssFinalBytes)} | ${mib(phase.rssPeakBytes)} | ${mib(phase.rssGrowthBytes)} | ${mib(phase.heapGrowthBytes)} | ${phase.domNodeGrowth ?? 'n/a'} |`,
  );
  return [
    '# Client memory soak',
    '',
    `**Verdict:** ${analysis.verdict}`,
    '',
    analysis.reason,
    '',
    '| Phase | Samples | RSS initial | RSS final | RSS peak | RSS growth | Heap growth | DOM growth |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...rows,
    '',
    `- RSS recovered after Browser Panel: ${mib(analysis.rssRecoveryAfterBrowserBytes)}`,
    `- RSS recovered after Terminal: ${mib(analysis.rssRecoveryAfterTerminalBytes)}`,
    '',
    'A flat JavaScript heap with rising RSS points to memory outside the main V8 isolate, such as workers, WASM, decoded images, canvas, or GPU/native buffers.',
    '',
  ].join('\n');
}
