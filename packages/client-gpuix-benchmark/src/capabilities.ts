import {
  BENCHMARK_CAPABILITY_SCHEMA_VERSION,
  supportedCapability,
  unsupportedCapability,
  type BenchmarkCapabilities,
} from '@funny/client-benchmark';

const pinnedSource = 'https://github.com/remorses/gpuix/tree/%40gpuix%2Freact%400.5.1';

export const GPUIX_BENCHMARK_CAPABILITIES: BenchmarkCapabilities = {
  schemaVersion: BENCHMARK_CAPABILITY_SCHEMA_VERSION,
  renderer: 'gpuix@0.5.1',
  capabilities: {
    frameTiming: unsupportedCapability(
      'GPUIX 0.5.1 exposes aggregate draw statistics but no raw presented-frame samples.',
      [
        {
          source: pinnedSource,
          detail: 'getDebugFrameOverlayStats exposes current, p90, p99, max, and counts only.',
        },
      ],
    ),
    presentationAcknowledgement: unsupportedCapability(
      'The public automation protocol declares a frame event, but the published server does not emit it.',
      [
        {
          source: pinnedSource,
          detail: 'AutomationServerEvent declares frame; no emission path exists.',
        },
      ],
    ),
    gpuMemory: unsupportedCapability('GPUIX 0.5.1 does not expose per-process GPU memory.', [
      {
        source: pinnedSource,
        detail: 'No GPU-memory query is present in the public native types.',
      },
    ]),
    screenshot: supportedCapability('GpuixRenderer.captureScreenshot', [
      {
        source: pinnedSource,
        detail: 'Production capture is published, with platform-specific runtime availability.',
      },
    ]),
    processSampling: supportedCapability('renderer orchestrator process-tree sampler'),
  },
};
