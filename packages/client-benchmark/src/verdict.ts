import { validateFeatureEquivalence, validatePairedRuns } from './comparison';
import type { BenchmarkResult, MetricSummary } from './result-schema';

export const DEFAULT_VERDICT_POLICY = {
  version: 1,
  scrollP95BudgetMs: 16.67,
  switchSlowdownLimit: 0.1,
  interactionOverBudgetRatio: 0.01,
  retainedMemoryGrowthLimit: 0.05,
  requiredImprovement: 0.2,
  noiseTolerance: 0.02,
} as const;

export type Verdict = 'go' | 'no-go' | 'inconclusive';

export interface ScenarioVerdict {
  verdict: Verdict;
  evidence: string[];
}

export interface BenchmarkVerdict {
  policy: typeof DEFAULT_VERDICT_POLICY;
  overall: Verdict;
  scenarios: {
    validity: ScenarioVerdict;
    equivalence: ScenarioVerdict;
    scroll: ScenarioVerdict;
    switch: ScenarioVerdict;
    interaction: ScenarioVerdict;
    memory: ScenarioVerdict;
    improvement: ScenarioVerdict;
  };
}

function summary(
  result: BenchmarkResult,
  workloadName: string,
  metric: string,
): MetricSummary | null {
  const workload = result.workloads.find((candidate) => candidate.name === workloadName);
  return workload?.summaries.find((candidate) => candidate.metric === metric) ?? null;
}

function missing(metric: string): ScenarioVerdict {
  return { verdict: 'inconclusive', evidence: [`Required metric unavailable: ${metric}`] };
}

function relativeImprovement(baseline: number, candidate: number): number {
  return baseline === 0 ? 0 : (baseline - candidate) / baseline;
}

function evaluateScroll(gpuix: BenchmarkResult): ScenarioVerdict {
  const value = summary(gpuix, 'scroll', 'frame-time');
  if (value?.p95 === null || value?.p95 === undefined || value.over16_67MsRatio === null) {
    return missing('GPUIX scroll frame-time p95 and budget ratio');
  }
  const passes =
    value.p95 <= DEFAULT_VERDICT_POLICY.scrollP95BudgetMs &&
    value.over16_67MsRatio < DEFAULT_VERDICT_POLICY.interactionOverBudgetRatio;
  return {
    verdict: passes ? 'go' : 'no-go',
    evidence: [
      `GPUIX scroll p95 ${value.p95}ms`,
      `samples over 16.67ms ${(value.over16_67MsRatio * 100).toFixed(2)}%`,
    ],
  };
}

function evaluateSwitch(web: BenchmarkResult, gpuix: BenchmarkResult): ScenarioVerdict {
  const webValue = summary(web, 'thread-switch', 'switch-latency')?.median;
  const gpuixValue = summary(gpuix, 'thread-switch', 'switch-latency')?.median;
  if (
    webValue === null ||
    webValue === undefined ||
    gpuixValue === null ||
    gpuixValue === undefined
  ) {
    return missing('paired thread-switch median');
  }
  const limit = webValue * (1 + DEFAULT_VERDICT_POLICY.switchSlowdownLimit);
  return {
    verdict: gpuixValue <= limit ? 'go' : 'no-go',
    evidence: [`React DOM ${webValue}ms`, `GPUIX ${gpuixValue}ms`, `limit ${limit}ms`],
  };
}

function evaluateInteraction(gpuix: BenchmarkResult): ScenarioVerdict {
  const ratios = ['scroll', 'streaming-update', 'input-present']
    .map((workload) => summary(gpuix, workload, 'input-to-present')?.over16_67MsRatio)
    .filter((value): value is number => value !== null && value !== undefined);
  if (ratios.length !== 3) return missing('all GPUIX input-to-present budget ratios');
  const worst = Math.max(...ratios);
  return {
    verdict: worst < DEFAULT_VERDICT_POLICY.interactionOverBudgetRatio ? 'go' : 'no-go',
    evidence: [`worst interaction over-budget ratio ${(worst * 100).toFixed(2)}%`],
  };
}

function evaluateMemory(gpuix: BenchmarkResult): ScenarioVerdict {
  const growth = summary(gpuix, 'repeated-navigation', 'rss-growth-ratio')?.median;
  if (growth === null || growth === undefined) return missing('GPUIX retained RSS growth ratio');
  return {
    verdict: growth <= DEFAULT_VERDICT_POLICY.retainedMemoryGrowthLimit ? 'go' : 'no-go',
    evidence: [`GPUIX retained RSS growth ${(growth * 100).toFixed(2)}%`],
  };
}

function evaluateImprovement(web: BenchmarkResult, gpuix: BenchmarkResult): ScenarioVerdict {
  const webRss = summary(web, 'idle', 'process-tree-rss')?.median;
  const gpuixRss = summary(gpuix, 'idle', 'process-tree-rss')?.median;
  const webInput = summary(web, 'input-present', 'input-to-present')?.p95;
  const gpuixInput = summary(gpuix, 'input-present', 'input-to-present')?.p95;
  const improvements: string[] = [];
  const values: number[] = [];
  if (webRss !== null && webRss !== undefined && gpuixRss !== null && gpuixRss !== undefined) {
    const improvement = relativeImprovement(webRss, gpuixRss);
    values.push(improvement);
    improvements.push(`RSS improvement ${(improvement * 100).toFixed(2)}%`);
  }
  if (
    webInput !== null &&
    webInput !== undefined &&
    gpuixInput !== null &&
    gpuixInput !== undefined
  ) {
    const improvement = relativeImprovement(webInput, gpuixInput);
    values.push(improvement);
    improvements.push(`input p95 improvement ${(improvement * 100).toFixed(2)}%`);
  }
  if (values.length === 0) return missing('paired RSS or input-to-present improvement');
  const best = Math.max(...values);
  if (
    Math.abs(best - DEFAULT_VERDICT_POLICY.requiredImprovement) <=
    DEFAULT_VERDICT_POLICY.noiseTolerance
  ) {
    return {
      verdict: 'inconclusive',
      evidence: [...improvements, 'difference is within noise tolerance'],
    };
  }
  return {
    verdict: best >= DEFAULT_VERDICT_POLICY.requiredImprovement ? 'go' : 'no-go',
    evidence: improvements,
  };
}

export function evaluateBenchmarkVerdict(
  web: BenchmarkResult,
  gpuix: BenchmarkResult,
): BenchmarkVerdict {
  const pair = validatePairedRuns(web, gpuix);
  const equivalence = validateFeatureEquivalence(web, gpuix);
  const scenarios: BenchmarkVerdict['scenarios'] = {
    validity: { verdict: pair.valid ? 'go' : 'inconclusive', evidence: pair.reasons },
    equivalence: {
      verdict: equivalence.valid ? 'go' : 'inconclusive',
      evidence: equivalence.reasons,
    },
    scroll: evaluateScroll(gpuix),
    switch: evaluateSwitch(web, gpuix),
    interaction: evaluateInteraction(gpuix),
    memory: evaluateMemory(gpuix),
    improvement: evaluateImprovement(web, gpuix),
  };
  const values = Object.values(scenarios).map((scenario) => scenario.verdict);
  const evidenceEligible =
    scenarios.validity.verdict === 'go' && scenarios.equivalence.verdict === 'go';
  const overall: Verdict = !evidenceEligible
    ? 'inconclusive'
    : values.includes('no-go')
      ? 'no-go'
      : values.includes('inconclusive')
        ? 'inconclusive'
        : 'go';
  return { policy: DEFAULT_VERDICT_POLICY, overall, scenarios };
}
