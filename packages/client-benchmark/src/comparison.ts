import type { BenchmarkResult } from './result-schema';

export interface ValidationResult {
  valid: boolean;
  reasons: string[];
}

function mismatch(reasons: string[], label: string, left: unknown, right: unknown): void {
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    reasons.push(`${label} mismatch: ${JSON.stringify(left)} !== ${JSON.stringify(right)}`);
  }
}

export function validatePairedRuns(web: BenchmarkResult, gpuix: BenchmarkResult): ValidationResult {
  const reasons = [...web.validity.reasons, ...gpuix.validity.reasons];
  if (!web.validity.valid) reasons.push('React DOM run is invalid');
  if (!gpuix.validity.valid) reasons.push('GPUIX run is invalid');
  mismatch(reasons, 'git revision', web.environment.gitRevision, gpuix.environment.gitRevision);
  mismatch(reasons, 'fixture version', web.fixture.version, gpuix.fixture.version);
  mismatch(reasons, 'viewport', web.environment.viewport, gpuix.environment.viewport);
  mismatch(reasons, 'theme', web.environment.theme, gpuix.environment.theme);
  mismatch(reasons, 'build mode', web.environment.buildMode, gpuix.environment.buildMode);
  mismatch(reasons, 'runtime version', web.renderer.runtimeVersion, gpuix.renderer.runtimeVersion);
  mismatch(reasons, 'OS', web.environment.os, gpuix.environment.os);
  mismatch(reasons, 'architecture', web.environment.architecture, gpuix.environment.architecture);
  mismatch(reasons, 'CPU', web.environment.cpu, gpuix.environment.cpu);
  mismatch(reasons, 'GPU', web.environment.gpu, gpuix.environment.gpu);
  mismatch(reasons, 'power state', web.environment.powerState, gpuix.environment.powerState);
  mismatch(
    reasons,
    'refresh target',
    web.environment.refreshTargetHz,
    gpuix.environment.refreshTargetHz,
  );
  return { valid: reasons.length === 0, reasons };
}

export function validateFeatureEquivalence(
  web: BenchmarkResult,
  gpuix: BenchmarkResult,
): ValidationResult {
  const reasons: string[] = [];
  mismatch(reasons, 'fixture version', web.fixture.version, gpuix.fixture.version);
  mismatch(reasons, 'fixture checksums', web.fixture.checksums, gpuix.fixture.checksums);
  mismatch(
    reasons,
    'feature inventory',
    web.fixture.featureInventory,
    gpuix.fixture.featureInventory,
  );
  mismatch(reasons, 'message count', web.fixture.messageCount, gpuix.fixture.messageCount);
  mismatch(reasons, 'tool-call count', web.fixture.toolCallCount, gpuix.fixture.toolCallCount);
  for (const [label, result] of [
    ['React DOM', web],
    ['GPUIX', gpuix],
  ] as const) {
    if (result.fixture.retainedItemCount === null)
      reasons.push(`${label} retained count is missing`);
    if (result.fixture.visibleItemCount === null) reasons.push(`${label} visible count is missing`);
  }
  return { valid: reasons.length === 0, reasons };
}
