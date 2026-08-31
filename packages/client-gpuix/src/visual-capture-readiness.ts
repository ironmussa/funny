export interface StableRendererEvidenceOptions {
  marker: string;
  readEvidence(): string;
  timeoutMs?: number;
  intervalMs?: number;
  stableReads?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface StableRendererEvidence {
  evidence: string;
  observations: number;
}

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function waitForStableRendererEvidence({
  marker,
  readEvidence,
  timeoutMs = 5_000,
  intervalMs = 16,
  stableReads = 2,
  now = () => performance.now(),
  sleep = delay,
}: StableRendererEvidenceOptions): Promise<StableRendererEvidence> {
  if (stableReads < 1) throw new Error('stableReads must be at least 1');
  const deadline = now() + timeoutMs;
  let previous = '';
  let consecutive = 0;
  let observations = 0;

  while (true) {
    const evidence = readEvidence();
    observations += 1;
    if (evidence.includes(marker)) {
      consecutive = evidence === previous ? consecutive + 1 : 1;
      if (consecutive >= stableReads) return { evidence, observations };
    } else {
      consecutive = 0;
    }
    previous = evidence;
    if (now() >= deadline) {
      throw new Error(
        `GPUIX visual fixture did not reach stable readiness: marker=${marker} observations=${observations}`,
      );
    }
    await sleep(intervalMs);
  }
}

export function unsupportedVisualCaptureEvidence(
  fixtureId: string,
  reason: string,
): Record<string, unknown> {
  return {
    fixtureId,
    screenshot: { supported: false, reason },
    structuralEvidence: 'available',
  };
}

export function failedVisualCaptureEvidence(
  fixtureId: string,
  error: unknown,
): Record<string, unknown> {
  return {
    fixtureId,
    screenshot: {
      supported: true,
      captured: false,
      error: error instanceof Error ? error.message : String(error),
    },
    structuralEvidence: 'not-ready',
  };
}
