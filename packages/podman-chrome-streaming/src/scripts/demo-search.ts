/**
 * demo-search.ts — Deterministic navigation + typing test
 *
 * Fixed route through static/stable pages only:
 *   Wikipedia → search box → known article → internal link → known page
 * Every run produces the exact same sequence.
 */
import { RemotePage } from '../lib/page.ts';

const page = await RemotePage.connect();

try {
  // ── Step 1: Wikipedia main page ───────────────────────────────────────────
  console.log('[demo-search] Step 1/6: Navigating to Wikipedia...');
  await page.goto('https://en.wikipedia.org/wiki/Main_Page');
  await page.sleep(1000);
  console.log(`[demo-search] Title: "${await page.title()}"`);

  // ── Step 2: Click search box and type a query ─────────────────────────────
  console.log('[demo-search] Step 2/6: Typing "TypeScript" in search...');
  await page.waitForSelector('input[name="search"]');
  await page.click('input[name="search"]');
  await page.sleep(300);
  await page.type('TypeScript', { delay: 80 });
  await page.sleep(800);

  // ── Step 3: Submit search — goes to the TypeScript article ────────────────
  console.log('[demo-search] Step 3/6: Pressing Enter...');
  await page.press('Enter');
  await page.sleep(2000);
  console.log(`[demo-search] Title: "${await page.title()}"`);
  console.log(`[demo-search] URL: ${await page.url()}`);

  // ── Step 4: Scroll through the TypeScript article ─────────────────────────
  console.log('[demo-search] Step 4/6: Scrolling article...');
  await page.scroll(0, 400);
  await page.sleep(600);
  await page.scroll(0, 400);
  await page.sleep(600);
  await page.scroll(0, -300);
  await page.sleep(500);

  // ── Step 5: Navigate to a known related article ───────────────────────────
  console.log('[demo-search] Step 5/6: Navigating to JavaScript article...');
  await page.goto('https://en.wikipedia.org/wiki/JavaScript');
  await page.sleep(1500);
  console.log(`[demo-search] Title: "${await page.title()}"`);

  await page.scroll(0, 500);
  await page.sleep(600);
  await page.scroll(0, 500);
  await page.sleep(600);

  // ── Step 6: Navigate to ECMAScript article ────────────────────────────────
  console.log('[demo-search] Step 6/6: Navigating to ECMAScript article...');
  await page.goto('https://en.wikipedia.org/wiki/ECMAScript');
  await page.sleep(1500);
  console.log(`[demo-search] Title: "${await page.title()}"`);
  console.log(`[demo-search] Final URL: ${await page.url()}`);

  console.log('[demo-search] Done! All 6 steps completed.');
} finally {
  await page.close();
}
