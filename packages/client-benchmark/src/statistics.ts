import type { MetricSample, MetricSummary } from './result-schema';

function sorted(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const valuesSorted = sorted(values);
  const middle = Math.floor(valuesSorted.length / 2);
  if (valuesSorted.length % 2 === 1) return valuesSorted[middle] ?? null;
  return ((valuesSorted[middle - 1] ?? 0) + (valuesSorted[middle] ?? 0)) / 2;
}

export function percentile(values: readonly number[], percentileValue: number): number | null {
  if (values.length === 0) return null;
  if (percentileValue < 0 || percentileValue > 1) {
    throw new Error(`Percentile must be between 0 and 1; received ${percentileValue}`);
  }
  const valuesSorted = sorted(values);
  const index = Math.max(0, Math.ceil(percentileValue * valuesSorted.length) - 1);
  return valuesSorted[index] ?? null;
}

export function medianAbsoluteDeviation(values: readonly number[]): number | null {
  const center = median(values);
  if (center === null) return null;
  return median(values.map((value) => Math.abs(value - center)));
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

export function bootstrapMedianConfidence(
  values: readonly number[],
  options: { seed?: number; iterations?: number } = {},
): { lower: number; upper: number; seed: number } | null {
  if (values.length === 0) return null;
  const seed = options.seed ?? 0x46554e4e;
  const iterations = options.iterations ?? 2_000;
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new Error(`Bootstrap iterations must be a positive integer; received ${iterations}`);
  }
  const random = seededRandom(seed);
  const medians: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration++) {
    const sample = Array.from(
      { length: values.length },
      () => values[Math.floor(random() * values.length)] ?? 0,
    );
    medians.push(median(sample) ?? 0);
  }
  return {
    lower: percentile(medians, 0.025) ?? 0,
    upper: percentile(medians, 0.975) ?? 0,
    seed,
  };
}

export function summarizeMetricSamples(
  samples: readonly MetricSample[],
  options: { bootstrapSeed?: number; bootstrapIterations?: number } = {},
): MetricSummary {
  if (samples.length === 0) throw new Error('Cannot summarize an empty metric sample set');
  const metric = samples[0]?.metric ?? '';
  const unit = samples[0]?.unit ?? 'count';
  if (samples.some((sample) => sample.metric !== metric || sample.unit !== unit)) {
    throw new Error('Metric samples must share one metric name and unit');
  }
  const values = samples.filter((sample) => sample.valid).map((sample) => sample.value);
  const timingValues = unit === 'ms' ? values : [];
  return {
    metric,
    unit,
    sampleCount: values.length,
    invalidCount: samples.length - values.length,
    median: median(values),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    maximum: values.length === 0 ? null : Math.max(...values),
    medianAbsoluteDeviation: medianAbsoluteDeviation(values),
    over16_67MsRatio:
      unit === 'ms' && timingValues.length > 0
        ? timingValues.filter((value) => value > 16.67).length / timingValues.length
        : null,
    over8_33MsRatio:
      unit === 'ms' && timingValues.length > 0
        ? timingValues.filter((value) => value > 8.33).length / timingValues.length
        : null,
    confidence95: bootstrapMedianConfidence(values, {
      seed: options.bootstrapSeed,
      iterations: options.bootstrapIterations,
    }),
  };
}
