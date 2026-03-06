/**
 * demo-visual-regression.ts — Deterministic visual regression test
 *
 * Navigates a fixed sequence of stable pages, takes a screenshot at each step,
 * and compares against saved baselines.
 *
 * First run:  creates baselines (all steps show "baseline created").
 * Next runs:  compares pixel-by-pixel and reports pass/fail + diff %.
 *
 * Baselines are stored at /app/snapshots/wiki-pages/ inside the container.
 * They persist as long as the container exists (use a volume to persist across rebuilds).
 */
import { RemotePage } from '../lib/page.ts';
import { VisualRegression } from '../lib/visual-regression.ts';

const page = await RemotePage.connect();
const vr = new VisualRegression('wiki-pages', {
  threshold: 0.1,
  maxDiffPercent: 1.0,
});

try {
  // ── Step 1: Wikipedia TypeScript article ──────────────────────────────────
  console.log('\n[vr] Step 1/4: Wikipedia — TypeScript');
  await page.goto('https://en.wikipedia.org/wiki/TypeScript');
  await page.sleep(1500);
  await page.press('Home');
  await page.sleep(300);
  await vr.capture(page, '01-typescript-article');

  // ── Step 2: Scroll to the infobox / first section ─────────────────────────
  console.log('\n[vr] Step 2/4: TypeScript article — scrolled');
  await page.scroll(0, 600);
  await page.sleep(800);
  await vr.capture(page, '02-typescript-scrolled');

  // ── Step 3: MDN Flexbox guide ─────────────────────────────────────────────
  console.log('\n[vr] Step 3/4: MDN — Flexbox guide');
  await page.goto(
    'https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_flexible_box_layout/Basic_concepts_of_flexbox',
  );
  await page.sleep(1500);
  await page.press('Home');
  await page.sleep(300);
  await vr.capture(page, '03-mdn-flexbox');

  // ── Step 4: MDN Grid layout guide ─────────────────────────────────────────
  console.log('\n[vr] Step 4/4: MDN — Grid layout guide');
  await page.goto(
    'https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_grid_layout/Basic_concepts_of_grid_layout',
  );
  await page.sleep(1500);
  await page.press('Home');
  await page.sleep(300);
  await vr.capture(page, '04-mdn-grid');

  // ── Report ────────────────────────────────────────────────────────────────
  const report = vr.report();

  if (report.failed > 0) {
    console.log(`\n⚠ ${report.failed} step(s) failed visual regression.`);
    console.log('  View diffs at: /snapshots/wiki-pages/diff/');
    console.log('  View report:   /snapshots/wiki-pages/report.json');
    process.exit(1);
  } else if (report.baselinesCreated > 0) {
    console.log(`\n📸 ${report.baselinesCreated} baseline(s) created on first run.`);
    console.log('  Run again to compare against them.');
  } else {
    console.log('\n✅ All steps passed visual regression!');
  }
} finally {
  await page.close();
}
