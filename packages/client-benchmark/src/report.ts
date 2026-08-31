import type { BenchmarkCapabilities } from './capabilities';
import { validateFeatureEquivalence, validatePairedRuns } from './comparison';
import type { BenchmarkResult, MetricSummary } from './result-schema';
import { DEFAULT_VERDICT_POLICY, evaluateBenchmarkVerdict, type BenchmarkVerdict } from './verdict';

export const RENDERER_COMPARISON_SCHEMA_VERSION = 2 as const;
export const RENDERER_STACK_LABEL = 'React DOM/Chromium versus React/GPUIX/GPUI' as const;

export interface ComparableMetric {
  workload: string;
  metric: string;
  unit: MetricSummary['unit'];
  web: MetricSummary;
  gpuix: MetricSummary;
  medianDelta: number | null;
  medianDeltaRatio: number | null;
}

export interface GpuixDrawDiagnostic {
  workload: string;
  overlayMode: string | null;
  currentMs: number | null;
  p90Ms: number | null;
  p99Ms: number | null;
  maxMs: number | null;
  totalFrames: number | null;
  sampleCount: number | null;
}

export interface RendererComparison {
  schemaVersion: typeof RENDERER_COMPARISON_SCHEMA_VERSION;
  label: typeof RENDERER_STACK_LABEL;
  generatedAt: string;
  webRunId: string;
  gpuixRunId: string;
  validity: ReturnType<typeof validatePairedRuns>;
  equivalence: ReturnType<typeof validateFeatureEquivalence>;
  comparableMetrics: ComparableMetric[];
  rendererDiagnostics: {
    webOnly: string[];
    gpuixOnly: string[];
    gpuixDraw: GpuixDrawDiagnostic[];
  };
  capabilityGaps: { web: string[]; gpuix: string[] };
  verdict: BenchmarkVerdict;
}

function unsupportedCapabilities(capabilities: BenchmarkCapabilities): string[] {
  return Object.entries(capabilities.capabilities).flatMap(([name, capability]) =>
    capability.status === 'unsupported' ? [`${name}: ${capability.reason}`] : [],
  );
}

function metricKey(workload: string, summary: MetricSummary): string {
  return `${workload}:${summary.metric}:${summary.unit}`;
}

function summaries(result: BenchmarkResult): Map<string, MetricSummary> {
  const values = new Map<string, MetricSummary>();
  for (const workload of result.workloads) {
    for (const summary of workload.summaries)
      values.set(metricKey(workload.name, summary), summary);
  }
  return values;
}

function numberDiagnostic(
  diagnostics: BenchmarkResult['workloads'][number]['diagnostics'],
  key: string,
): number | null {
  const value = diagnostics[key];
  return typeof value === 'number' ? value : null;
}

function gpuixDrawDiagnostics(result: BenchmarkResult): GpuixDrawDiagnostic[] {
  return result.workloads.flatMap((workload) => {
    if (!('nativeDrawSampleCount' in workload.diagnostics)) return [];
    const overlayMode = workload.diagnostics.nativeFrameOverlayMode;
    return [
      {
        workload: workload.name,
        overlayMode: typeof overlayMode === 'string' ? overlayMode : null,
        currentMs: numberDiagnostic(workload.diagnostics, 'nativeDrawCurrentMs'),
        p90Ms: numberDiagnostic(workload.diagnostics, 'nativeDrawP90Ms'),
        p99Ms: numberDiagnostic(workload.diagnostics, 'nativeDrawP99Ms'),
        maxMs: numberDiagnostic(workload.diagnostics, 'nativeDrawMaxMs'),
        totalFrames: numberDiagnostic(workload.diagnostics, 'nativeDrawTotalFrames'),
        sampleCount: numberDiagnostic(workload.diagnostics, 'nativeDrawSampleCount'),
      },
    ];
  });
}

export function createRendererComparison(
  web: BenchmarkResult,
  gpuix: BenchmarkResult,
  generatedAt = new Date().toISOString(),
): RendererComparison {
  const webMetrics = summaries(web);
  const gpuixMetrics = summaries(gpuix);
  const comparableMetrics: ComparableMetric[] = [];
  for (const [key, webSummary] of webMetrics) {
    const gpuixSummary = gpuixMetrics.get(key);
    if (!gpuixSummary) continue;
    const webMedian = webSummary.median;
    const gpuixMedian = gpuixSummary.median;
    comparableMetrics.push({
      workload: key.split(':')[0] ?? '',
      metric: webSummary.metric,
      unit: webSummary.unit,
      web: webSummary,
      gpuix: gpuixSummary,
      medianDelta: webMedian === null || gpuixMedian === null ? null : gpuixMedian - webMedian,
      medianDeltaRatio:
        webMedian === null || gpuixMedian === null || webMedian === 0
          ? null
          : (gpuixMedian - webMedian) / webMedian,
    });
  }
  return {
    schemaVersion: RENDERER_COMPARISON_SCHEMA_VERSION,
    label: RENDERER_STACK_LABEL,
    generatedAt,
    webRunId: web.runId,
    gpuixRunId: gpuix.runId,
    validity: validatePairedRuns(web, gpuix),
    equivalence: validateFeatureEquivalence(web, gpuix),
    comparableMetrics,
    rendererDiagnostics: {
      webOnly: [...webMetrics.keys()].filter((key) => !gpuixMetrics.has(key)),
      gpuixOnly: [...gpuixMetrics.keys()].filter((key) => !webMetrics.has(key)),
      gpuixDraw: gpuixDrawDiagnostics(gpuix),
    },
    capabilityGaps: {
      web: unsupportedCapabilities(web.capabilities),
      gpuix: unsupportedCapabilities(gpuix.capabilities),
    },
    verdict: evaluateBenchmarkVerdict(web, gpuix),
  };
}

function formatValue(value: number | null, unit: string): string {
  if (value === null) return 'unavailable';
  if (unit === 'bytes') return `${(value / 1024 / 1024).toFixed(2)} MiB`;
  if (unit === 'percent') return `${(value * 100).toFixed(2)}%`;
  return `${value.toFixed(2)} ${unit}`;
}

function formatMedianWithConfidence(summary: MetricSummary): string {
  const median = formatValue(summary.median, summary.unit);
  if (!summary.confidence95) return median;
  return `${median} [${formatValue(summary.confidence95.lower, summary.unit)}, ${formatValue(summary.confidence95.upper, summary.unit)}]`;
}

function evidenceList(evidence: readonly string[]): string {
  return evidence.length === 0 ? 'none' : evidence.join('; ');
}

function formatOptionalNumber(value: number | null, digits = 2): string {
  return value === null ? 'unavailable' : value.toFixed(digits);
}

export function renderRendererComparisonMarkdown(comparison: RendererComparison): string {
  const lines = [
    '# Renderer benchmark comparison',
    '',
    `Stack comparison: **${comparison.label}**. Both stacks may use GPU acceleration; this is not a CPU-versus-GPU test.`,
    '',
    `Overall verdict: **${comparison.verdict.overall}**`,
    '',
    '## Evidence eligibility',
    '',
    `- Paired controls: ${comparison.validity.valid ? 'valid' : 'invalid'} — ${evidenceList(comparison.validity.reasons)}`,
    `- Feature equivalence: ${comparison.equivalence.valid ? 'valid' : 'incomparable'} — ${evidenceList(comparison.equivalence.reasons)}`,
    '',
    '## Directly comparable metrics',
    '',
    '| Workload | Metric | React DOM median [95% CI] | GPUIX median [95% CI] | GPUIX delta |',
    '| --- | --- | ---: | ---: | ---: |',
  ];
  if (comparison.comparableMetrics.length === 0) {
    lines.push('| — | No shared metric definitions | — | — | — |');
  } else {
    for (const metric of comparison.comparableMetrics) {
      lines.push(
        `| ${metric.workload} | ${metric.metric} | ${formatMedianWithConfidence(metric.web)} | ${formatMedianWithConfidence(metric.gpuix)} | ${metric.medianDeltaRatio === null ? 'unavailable' : `${(metric.medianDeltaRatio * 100).toFixed(2)}%`} |`,
      );
    }
  }
  lines.push(
    '',
    '## Scenario verdicts',
    '',
    '| Scenario | Verdict | Evidence |',
    '| --- | --- | --- |',
  );
  for (const [name, scenario] of Object.entries(comparison.verdict.scenarios)) {
    lines.push(`| ${name} | ${scenario.verdict} | ${evidenceList(scenario.evidence)} |`);
  }
  lines.push(
    '',
    '## Configured targets',
    '',
    `- Scroll p95: at most ${DEFAULT_VERDICT_POLICY.scrollP95BudgetMs} ms.`,
    `- Thread-switch slowdown: at most ${DEFAULT_VERDICT_POLICY.switchSlowdownLimit * 100}%.`,
    `- Interaction samples beyond 16.67 ms: below ${DEFAULT_VERDICT_POLICY.interactionOverBudgetRatio * 100}%.`,
    `- Repeated-navigation retained-memory growth: at most ${DEFAULT_VERDICT_POLICY.retainedMemoryGrowthLimit * 100}%.`,
    `- Required improvement in RSS or input-to-present p95: at least ${DEFAULT_VERDICT_POLICY.requiredImprovement * 100}%.`,
    '',
    '## Renderer-specific diagnostics',
    '',
    `- React DOM/Chromium only: ${comparison.rendererDiagnostics.webOnly.join(', ') || 'none'}.`,
    `- React/GPUIX/GPUI only: ${comparison.rendererDiagnostics.gpuixOnly.join(', ') || 'none'}.`,
  );
  if (comparison.rendererDiagnostics.gpuixDraw.length > 0) {
    lines.push(
      '',
      '### GPUIX native draw overlay',
      '',
      'These aggregate layout/draw costs are GPUIX-only diagnostics, not presented-frame latency or GPU memory.',
      '',
      '| Workload | Overlay | Current (ms) | P90 (ms) | P99 (ms) | Max (ms) | Total frames | Samples |',
      '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    );
    for (const diagnostic of comparison.rendererDiagnostics.gpuixDraw) {
      lines.push(
        `| ${diagnostic.workload} | ${diagnostic.overlayMode ?? 'unavailable'} | ${formatOptionalNumber(diagnostic.currentMs)} | ${formatOptionalNumber(diagnostic.p90Ms)} | ${formatOptionalNumber(diagnostic.p99Ms)} | ${formatOptionalNumber(diagnostic.maxMs)} | ${formatOptionalNumber(diagnostic.totalFrames, 0)} | ${formatOptionalNumber(diagnostic.sampleCount, 0)} |`,
      );
    }
  }
  lines.push(
    '',
    '## Capability gaps',
    '',
    `- React DOM/Chromium: ${comparison.capabilityGaps.web.join('; ') || 'none'}.`,
    `- React/GPUIX/GPUI: ${comparison.capabilityGaps.gpuix.join('; ') || 'none'}.`,
    '',
    'This report describes the recorded machine and source revision only. Re-run the controlled profile before making a product-renderer decision.',
    '',
  );
  return lines.join('\n');
}
