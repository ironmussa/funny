#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { desktopParityFixture } from '@funny/ui-contracts/fixtures';
import { createRenderer, createRoot, flushSync, startFrameLoop } from '@gpuix/react';

import {
  failedVisualCaptureEvidence,
  unsupportedVisualCaptureEvidence,
  waitForStableRendererEvidence,
} from '../src/visual-capture-readiness';
import { GpuixVisualParityFixtureHost } from '../src/visual-parity-fixture';

const outputDirectory = resolve(
  process.env.FUNNY_ASSETS_DIR ?? '../../benchmark-results/visual-parity',
);
const evidencePath = join(outputDirectory, 'gpuix-reference-dark.json');
const screenshotPath = join(outputDirectory, 'gpuix-reference-dark.png');
mkdirSync(dirname(evidencePath), { recursive: true });

if (process.platform !== 'darwin' && process.platform !== 'win32') {
  writeFileSync(
    evidencePath,
    JSON.stringify(
      unsupportedVisualCaptureEvidence(
        desktopParityFixture.id,
        'GPUIX 0.5.1 captureScreenshot is supported only by Metal and DirectX hosts.',
      ),
      null,
      2,
    ),
  );
  process.stdout.write(`${evidencePath}\n`);
  process.exit(0);
}

const renderer = createRenderer();
renderer.init({
  title: 'Funny visual parity fixture',
  width: 1440,
  height: 900,
});
const root = createRoot(renderer);
flushSync(() => root.render(<GpuixVisualParityFixtureHost fixture={desktopParityFixture} />));
const loop = startFrameLoop(renderer);
try {
  await waitForStableRendererEvidence({
    marker: `parity-fixture-${desktopParityFixture.id}`,
    readEvidence: () => renderer.getAutomationTree(),
  });
  renderer.captureScreenshot(screenshotPath);
  writeFileSync(
    evidencePath,
    JSON.stringify(
      {
        fixtureId: desktopParityFixture.id,
        screenshot: { supported: true, path: screenshotPath },
        tolerances: {
          geometryPx: 4,
          colorChannel: 6,
          excluded: ['text-antialiasing', 'native-scrollbars', 'diagnostic-overlays'],
        },
      },
      null,
      2,
    ),
  );
} catch (error) {
  writeFileSync(
    evidencePath,
    JSON.stringify(failedVisualCaptureEvidence(desktopParityFixture.id, error), null, 2),
  );
  throw error;
} finally {
  loop.stop();
  root.unmount();
}
process.stdout.write(`${screenshotPath}\n`);
