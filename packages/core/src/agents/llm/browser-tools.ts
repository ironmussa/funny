/**
 * Browser tools for the E2E agent — Playwright with plain tool definitions.
 *
 * Lazy browser initialization: Chromium is only launched on the first tool call.
 * Cleanup via dispose() closes the browser and releases resources.
 */

import type { Browser, Page } from 'playwright';
import { z } from 'zod';

import type { ToolDef } from './agent-executor.js';

export interface BrowserToolsContext {
  /** Base URL of the app to test (e.g., http://localhost:3000) */
  appUrl: string;
}

export interface BrowserToolsHandle {
  tools: Record<string, ToolDef>;
  dispose: () => Promise<void>;
}

export function createBrowserTools(ctx: BrowserToolsContext): BrowserToolsHandle {
  let browser: Browser | null = null;
  let page: Page | null = null;
  const consoleErrors: string[] = [];

  async function ensurePage(): Promise<Page> {
    if (!browser) {
      const { chromium } = await import('playwright');
      browser = await chromium.launch({ headless: true });
      const browserContext = await browser.newContext({
        viewport: { width: 1280, height: 720 },
      });
      page = await browserContext.newPage();

      // Capture console errors from the start
      page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
      });

      await page.goto(ctx.appUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    }
    return page!;
  }

  async function dispose() {
    if (browser) {
      await browser.close().catch(() => {});
      browser = null;
      page = null;
    }
  }

  const tools: Record<string, ToolDef> = {
    browser_navigate: {
      description: 'Navigate the browser to a URL.',
      parameters: z.object({
        url: z.string().describe('The URL to navigate to'),
      }),
      execute: async ({ url }) => {
        const p = await ensurePage();
        await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        const title = await p.title();
        return `Navigated to: ${p.url()}\nTitle: ${title}`;
      },
    },

    browser_screenshot: {
      description: 'Take a screenshot of the current page. Returns base64 PNG.',
      parameters: z.object({
        fullPage: z
          .boolean()
          .optional()
          .default(false)
          .describe('Whether to capture the full scrollable page'),
      }),
      execute: async ({ fullPage }) => {
        const p = await ensurePage();
        const buf = await p.screenshot({ fullPage, type: 'png' });
        return `data:image/png;base64,${buf.toString('base64')}`;
      },
    },

    browser_click: {
      description: 'Click an element matching a CSS selector.',
      parameters: z.object({
        selector: z.string().describe('CSS selector of the element to click'),
        timeout: z
          .number()
          .optional()
          .default(5000)
          .describe('Max time in ms to wait for the element'),
      }),
      execute: async ({ selector, timeout }) => {
        const p = await ensurePage();
        await p.click(selector, { timeout });
        return `Clicked: ${selector}`;
      },
    },

    browser_get_dom: {
      description: 'Get the HTML content of the current page or a specific element.',
      parameters: z.object({
        selector: z.string().optional().describe('CSS selector. Omit to get the full page body.'),
      }),
      execute: async ({ selector }) => {
        const p = await ensurePage();
        let html: string;

        if (selector) {
          const el = await p.$(selector);
          if (!el) return `No element found matching selector: ${selector}`;
          html = await el.evaluate((e) => e.outerHTML);
        } else {
          html = await p.evaluate(() => document.body.outerHTML);
        }

        const maxLength = 50_000;
        if (html.length > maxLength) {
          html = html.slice(0, maxLength) + '\n\n... [truncated, use a more specific selector]';
        }
        return html;
      },
    },

    browser_console_errors: {
      description: 'Get all console errors captured since the browser was opened.',
      parameters: z.object({}),
      execute: async () => {
        await ensurePage(); // ensure listener is set up
        return consoleErrors.length ? consoleErrors.join('\n') : 'No console errors detected.';
      },
    },
  };

  return { tools, dispose };
}
