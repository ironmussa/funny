/**
 * CDP MCP Server — in-process MCP server providing browser automation tools.
 *
 * Uses Playwright for headless Chrome control. Creates tools for:
 * - cdp_navigate: Navigate to a URL
 * - cdp_screenshot: Take a screenshot of the current page
 * - cdp_get_dom: Get the DOM HTML of the page or a specific selector
 *
 * The browser is lazily initialized on first tool call and cleaned up
 * when dispose() is called.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { Browser, Page } from 'playwright';
import { z } from 'zod';

export interface CdpMcpServerOptions {
  /** Base URL of the containerized app (e.g., http://localhost:30042) */
  appUrl: string;
}

export interface CdpMcpServerResult {
  /** The MCP server config to pass to query() via mcpServers */
  server: ReturnType<typeof createSdkMcpServer>;
  /** Call to close the browser and release resources */
  dispose: () => Promise<void>;
}

/**
 * Create an in-process MCP server with CDP browser tools.
 *
 * Returns the server config and a dispose function for cleanup.
 */
export function createCdpMcpServer(opts: CdpMcpServerOptions): CdpMcpServerResult {
  let browser: Browser | null = null;
  let page: Page | null = null;

  async function ensurePage(): Promise<Page> {
    if (!browser) {
      const { chromium } = await import('playwright');
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
      });
      page = await context.newPage();
      // Navigate to the app URL by default
      await page.goto(opts.appUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    }
    return page!;
  }

  async function dispose(): Promise<void> {
    if (browser) {
      await browser.close().catch(() => {});
      browser = null;
      page = null;
    }
  }

  const server = createSdkMcpServer({
    name: 'cdp-browser',
    version: '1.0.0',
    tools: [
      tool(
        'cdp_navigate',
        'Navigate the browser to a URL. Use this to visit pages in the containerized app.',
        {
          url: z.string().describe('The URL to navigate to'),
        },
        async (args) => {
          const p = await ensurePage();
          await p.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          const title = await p.title();
          return {
            content: [
              {
                type: 'text' as const,
                text: `Navigated to: ${p.url()}\nTitle: ${title}`,
              },
            ],
          };
        },
      ),

      tool(
        'cdp_screenshot',
        'Take a screenshot of the current browser page. Returns a PNG image.',
        {
          fullPage: z
            .boolean()
            .optional()
            .default(false)
            .describe('Whether to capture the full scrollable page'),
        },
        async (args) => {
          const p = await ensurePage();
          const buffer = await p.screenshot({
            fullPage: args.fullPage,
            type: 'png',
          });
          return {
            content: [
              {
                type: 'image' as const,
                data: buffer.toString('base64'),
                mimeType: 'image/png' as const,
              },
            ],
          };
        },
      ),

      tool(
        'cdp_get_dom',
        'Get the HTML content of the current page or a specific element. Useful for inspecting the DOM structure.',
        {
          selector: z
            .string()
            .optional()
            .describe('CSS selector to get HTML for. Omit to get the full page body.'),
        },
        async (args) => {
          const p = await ensurePage();
          let html: string;

          if (args.selector) {
            const element = await p.$(args.selector);
            if (!element) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `No element found matching selector: ${args.selector}`,
                  },
                ],
              };
            }
            html = await element.evaluate((el) => el.outerHTML);
          } else {
            html = await p.evaluate(() => document.body.outerHTML);
          }

          // Truncate very large DOMs to avoid context overload
          const maxLength = 50_000;
          if (html.length > maxLength) {
            html = html.slice(0, maxLength) + '\n\n... [truncated, use a more specific selector]';
          }

          return {
            content: [
              {
                type: 'text' as const,
                text: html,
              },
            ],
          };
        },
      ),
    ],
  });

  return { server, dispose };
}
