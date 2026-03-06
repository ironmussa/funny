import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';

import pixelmatch from 'pixelmatch';
/**
 * VisualRegression — screenshot capture + pixel-level comparison.
 *
 * First run:  saves screenshots as baselines.
 * Next runs:  compares actual vs baseline and generates diff images.
 *
 * Usage:
 *   const vr = new VisualRegression("my-suite");
 *   const page = await RemotePage.connect();
 *   await page.goto("https://example.com");
 *   await vr.capture(page, "homepage");
 *   const report = vr.report();
 */
import { PNG } from 'pngjs';

import type { RemotePage } from './page.ts';

function getSnapshotsRoot(): string {
  return process.env.SNAPSHOTS_ROOT || '/app/snapshots';
}

export interface StepResult {
  name: string;
  status: 'pass' | 'fail' | 'baseline_created';
  diffPixels: number;
  diffPercent: number;
  totalPixels: number;
  baselinePath: string;
  actualPath: string;
  diffPath: string;
}

export interface SuiteReport {
  suite: string;
  timestamp: string;
  steps: StepResult[];
  passed: number;
  failed: number;
  baselinesCreated: number;
}

export class VisualRegression {
  private suite: string;
  private baselineDir: string;
  private actualDir: string;
  private diffDir: string;
  private results: StepResult[] = [];
  private threshold: number;
  private maxDiffPercent: number;

  constructor(suite: string, options: { threshold?: number; maxDiffPercent?: number } = {}) {
    this.suite = suite;
    this.threshold = options.threshold ?? 0.1;
    this.maxDiffPercent = options.maxDiffPercent ?? 0.5;

    const snapshotsRoot = getSnapshotsRoot();
    this.baselineDir = join(snapshotsRoot, suite, 'baseline');
    this.actualDir = join(snapshotsRoot, suite, 'actual');
    this.diffDir = join(snapshotsRoot, suite, 'diff');

    mkdirSync(this.baselineDir, { recursive: true });
    mkdirSync(this.actualDir, { recursive: true });
    mkdirSync(this.diffDir, { recursive: true });
  }

  /**
   * Capture a screenshot and compare against the baseline.
   * If no baseline exists, the screenshot becomes the baseline.
   */
  async capture(page: RemotePage, stepName: string): Promise<StepResult> {
    const filename = `${stepName}.png`;
    const baselinePath = join(this.baselineDir, filename);
    const actualPath = join(this.actualDir, filename);
    const diffPath = join(this.diffDir, filename);

    // Take screenshot (base64 PNG from CDP)
    const pngBase64 = await page.screenshot();
    const pngBuffer = Buffer.from(pngBase64, 'base64');
    writeFileSync(actualPath, pngBuffer);

    if (!existsSync(baselinePath)) {
      // No baseline yet — save current as baseline
      writeFileSync(baselinePath, pngBuffer);
      const result: StepResult = {
        name: stepName,
        status: 'baseline_created',
        diffPixels: 0,
        diffPercent: 0,
        totalPixels: 0,
        baselinePath,
        actualPath,
        diffPath: '',
      };
      this.results.push(result);
      console.log(`  📸 [${stepName}] Baseline created`);
      return result;
    }

    // Compare against baseline
    const baselineBuffer = readFileSync(baselinePath);
    const baselinePng = PNG.sync.read(baselineBuffer);
    const actualPng = PNG.sync.read(pngBuffer);

    // Handle size mismatch: re-create baseline
    if (baselinePng.width !== actualPng.width || baselinePng.height !== actualPng.height) {
      console.log(
        `  ⚠ [${stepName}] Size changed: ${baselinePng.width}x${baselinePng.height} → ${actualPng.width}x${actualPng.height}. Updating baseline.`,
      );
      writeFileSync(baselinePath, pngBuffer);
      const result: StepResult = {
        name: stepName,
        status: 'baseline_created',
        diffPixels: 0,
        diffPercent: 0,
        totalPixels: 0,
        baselinePath,
        actualPath,
        diffPath: '',
      };
      this.results.push(result);
      return result;
    }

    const { width, height } = baselinePng;
    const totalPixels = width * height;
    const diffOutput = new PNG({ width, height });

    const diffPixels = pixelmatch(
      baselinePng.data,
      actualPng.data,
      diffOutput.data,
      width,
      height,
      { threshold: this.threshold, includeAA: false },
    );

    // Write diff image
    writeFileSync(diffPath, PNG.sync.write(diffOutput));

    const diffPercent = (diffPixels / totalPixels) * 100;
    const passed = diffPercent <= this.maxDiffPercent;

    const result: StepResult = {
      name: stepName,
      status: passed ? 'pass' : 'fail',
      diffPixels,
      diffPercent: Math.round(diffPercent * 100) / 100,
      totalPixels,
      baselinePath,
      actualPath,
      diffPath,
    };
    this.results.push(result);

    if (passed) {
      console.log(`  ✅ [${stepName}] PASS — ${diffPixels} pixels differ (${result.diffPercent}%)`);
    } else {
      console.log(
        `  ❌ [${stepName}] FAIL — ${diffPixels} pixels differ (${result.diffPercent}%) exceeds ${this.maxDiffPercent}%`,
      );
    }

    return result;
  }

  /**
   * Update the baseline for a specific step with the current actual screenshot.
   */
  updateBaseline(stepName: string): void {
    const filename = `${stepName}.png`;
    const baselinePath = join(this.baselineDir, filename);
    const actualPath = join(this.actualDir, filename);
    if (existsSync(actualPath)) {
      const data = readFileSync(actualPath);
      writeFileSync(baselinePath, data);
      console.log(`  🔄 [${stepName}] Baseline updated`);
    }
  }

  /**
   * Update ALL baselines with current actuals.
   */
  updateAllBaselines(): void {
    for (const result of this.results) {
      this.updateBaseline(result.name);
    }
  }

  report(): SuiteReport {
    const report: SuiteReport = {
      suite: this.suite,
      timestamp: new Date().toISOString(),
      steps: this.results,
      passed: this.results.filter((r) => r.status === 'pass').length,
      failed: this.results.filter((r) => r.status === 'fail').length,
      baselinesCreated: this.results.filter((r) => r.status === 'baseline_created').length,
    };

    console.log('\n══════════════════════════════════════════');
    console.log(`  Visual Regression Report: ${this.suite}`);
    console.log('══════════════════════════════════════════');
    console.log(`  Steps:    ${report.steps.length}`);
    console.log(`  Passed:   ${report.passed}`);
    console.log(`  Failed:   ${report.failed}`);
    console.log(`  New:      ${report.baselinesCreated}`);
    console.log('──────────────────────────────────────────');

    for (const step of report.steps) {
      const icon = step.status === 'pass' ? '✅' : step.status === 'fail' ? '❌' : '📸';
      const detail =
        step.status === 'baseline_created'
          ? 'baseline created'
          : `${step.diffPixels} px (${step.diffPercent}%)`;
      console.log(`  ${icon} ${step.name}: ${detail}`);
    }

    console.log('══════════════════════════════════════════\n');

    // Save report as JSON
    const reportPath = join(getSnapshotsRoot(), this.suite, 'report.json');
    writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');

    return report;
  }

  /**
   * List all suites that have snapshots.
   */
  static listSuites(): string[] {
    const snapshotsRoot = getSnapshotsRoot();
    if (!existsSync(snapshotsRoot)) return [];
    return readdirSync(snapshotsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  }

  /**
   * Get paths to baseline/actual/diff for a step.
   * Useful for serving images via HTTP.
   */
  static getStepImages(
    suite: string,
    step: string,
  ): {
    baseline: string | null;
    actual: string | null;
    diff: string | null;
  } {
    const base = join(getSnapshotsRoot(), suite);
    const file = `${step}.png`;
    const baseline = join(base, 'baseline', file);
    const actual = join(base, 'actual', file);
    const diff = join(base, 'diff', file);
    return {
      baseline: existsSync(baseline) ? baseline : null,
      actual: existsSync(actual) ? actual : null,
      diff: existsSync(diff) ? diff : null,
    };
  }
}
