import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';

import { PNG } from 'pngjs';

import { VisualRegression } from '../lib/visual-regression.ts';

const TMP_ROOT = join(import.meta.dir, '..', '..', '.test-tmp-snapshots');
const originalSnapshotsRoot = process.env.SNAPSHOTS_ROOT;

function pngBase64(width: number, height: number, rgba: [number, number, number, number]) {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = rgba[0];
    png.data[i + 1] = rgba[1];
    png.data[i + 2] = rgba[2];
    png.data[i + 3] = rgba[3];
  }
  return PNG.sync.write(png).toString('base64');
}

beforeEach(() => {
  process.env.SNAPSHOTS_ROOT = TMP_ROOT;
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

afterEach(() => {
  if (originalSnapshotsRoot === undefined) {
    delete process.env.SNAPSHOTS_ROOT;
  } else {
    process.env.SNAPSHOTS_ROOT = originalSnapshotsRoot;
  }
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe('VisualRegression', () => {
  it('creates a baseline on first capture', async () => {
    const vr = new VisualRegression('suite-baseline');
    const page = {
      screenshot: async () => pngBase64(2, 2, [255, 0, 0, 255]),
    };

    const result = await vr.capture(page as any, 'home');

    expect(result.status).toBe('baseline_created');
    expect(existsSync(result.baselinePath)).toBe(true);
    expect(existsSync(result.actualPath)).toBe(true);
    expect(result.diffPath).toBe('');
  });

  it('passes when the actual screenshot matches the baseline', async () => {
    const vr = new VisualRegression('suite-pass', {
      maxDiffPercent: 0,
    });
    const page = {
      screenshot: async () => pngBase64(2, 2, [0, 255, 0, 255]),
    };

    await vr.capture(page as any, 'same');
    const result = await vr.capture(page as any, 'same');

    expect(result.status).toBe('pass');
    expect(result.diffPixels).toBe(0);
    expect(existsSync(result.diffPath)).toBe(true);
  });

  it('fails when the screenshot differs beyond the configured threshold', async () => {
    const vr = new VisualRegression('suite-fail', {
      maxDiffPercent: 0,
    });

    await vr.capture(
      {
        screenshot: async () => pngBase64(2, 2, [0, 0, 0, 255]),
      } as any,
      'step',
    );

    const result = await vr.capture(
      {
        screenshot: async () => pngBase64(2, 2, [255, 255, 255, 255]),
      } as any,
      'step',
    );

    expect(result.status).toBe('fail');
    expect(result.diffPixels).toBeGreaterThan(0);
    expect(result.diffPercent).toBeGreaterThan(0);
  });

  it('recreates the baseline when image dimensions change', async () => {
    const vr = new VisualRegression('suite-resize');

    await vr.capture(
      {
        screenshot: async () => pngBase64(2, 2, [10, 20, 30, 255]),
      } as any,
      'resized',
    );

    const result = await vr.capture(
      {
        screenshot: async () => pngBase64(3, 3, [10, 20, 30, 255]),
      } as any,
      'resized',
    );

    expect(result.status).toBe('baseline_created');
    const rewrittenBaseline = PNG.sync.read(readFileSync(result.baselinePath));
    expect(rewrittenBaseline.width).toBe(3);
    expect(rewrittenBaseline.height).toBe(3);
  });

  it('updates baselines from the latest actual images', async () => {
    const vr = new VisualRegression('suite-update');

    await vr.capture(
      {
        screenshot: async () => pngBase64(2, 2, [10, 10, 10, 255]),
      } as any,
      'step',
    );

    const result = await vr.capture(
      {
        screenshot: async () => pngBase64(2, 2, [20, 20, 20, 255]),
      } as any,
      'step',
    );

    const before = readFileSync(result.baselinePath);
    vr.updateBaseline('step');
    const after = readFileSync(result.baselinePath);

    expect(Buffer.compare(before, after)).not.toBe(0);
    expect(Buffer.compare(after, readFileSync(result.actualPath))).toBe(0);
  });

  it('produces a report and exposes suite artifacts', async () => {
    const vr = new VisualRegression('suite-report');

    await vr.capture(
      {
        screenshot: async () => pngBase64(2, 2, [1, 2, 3, 255]),
      } as any,
      'one',
    );

    const report = vr.report();

    expect(report.suite).toBe('suite-report');
    expect(report.steps).toHaveLength(1);
    expect(VisualRegression.listSuites()).toContain('suite-report');

    const images = VisualRegression.getStepImages('suite-report', 'one');
    expect(images.baseline).not.toBeNull();
    expect(images.actual).not.toBeNull();
    expect(images.diff).toBeNull();
  });
});
