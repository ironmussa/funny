/**
 * demo-scroll.ts — Deterministic scroll & navigation test
 *
 * Fixed route: MDN CSS page → specific section → known internal link.
 * Every run follows the exact same path through the same content.
 */
import { RemotePage } from '../lib/page.ts';

const page = await RemotePage.connect();

async function smoothScroll(totalPx: number, steps = 12) {
  const step = totalPx / steps;
  for (let i = 0; i < steps; i++) {
    await page.scroll(0, step);
    await page.sleep(100);
  }
}

try {
  // ── Step 1: MDN CSS reference ─────────────────────────────────────────────
  console.log('[demo-scroll] Step 1/5: Navigating to MDN CSS reference...');
  await page.goto('https://developer.mozilla.org/en-US/docs/Web/CSS');
  await page.sleep(1200);
  console.log(`[demo-scroll] Title: "${await page.title()}"`);

  // ── Step 2: Scroll through the CSS page ───────────────────────────────────
  console.log('[demo-scroll] Step 2/5: Scrolling through CSS reference...');
  await smoothScroll(600);
  await page.sleep(800);
  await smoothScroll(600);
  await page.sleep(800);
  await smoothScroll(400);
  await page.sleep(600);

  // ── Step 3: Navigate to Flexbox guide (fixed link) ────────────────────────
  console.log('[demo-scroll] Step 3/5: Navigating to Flexbox guide...');
  await page.goto(
    'https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_flexible_box_layout/Basic_concepts_of_flexbox',
  );
  await page.sleep(1500);
  console.log(`[demo-scroll] Title: "${await page.title()}"`);

  console.log('[demo-scroll] Scrolling Flexbox guide...');
  await smoothScroll(500);
  await page.sleep(600);
  await smoothScroll(500);
  await page.sleep(600);
  await smoothScroll(500);
  await page.sleep(600);

  // ── Step 4: Navigate to Grid guide (fixed link) ──────────────────────────
  console.log('[demo-scroll] Step 4/5: Navigating to CSS Grid guide...');
  await page.goto(
    'https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_grid_layout/Basic_concepts_of_grid_layout',
  );
  await page.sleep(1500);
  console.log(`[demo-scroll] Title: "${await page.title()}"`);

  console.log('[demo-scroll] Scrolling Grid guide...');
  await smoothScroll(800);
  await page.sleep(700);
  await smoothScroll(800);
  await page.sleep(700);

  // ── Step 5: Scroll back to top ────────────────────────────────────────────
  console.log('[demo-scroll] Step 5/5: Scrolling back to top...');
  await page.press('Home');
  await page.sleep(800);

  console.log(`[demo-scroll] Final URL: ${await page.url()}`);
  console.log('[demo-scroll] Done! All 5 steps completed.');
} finally {
  await page.close();
}
