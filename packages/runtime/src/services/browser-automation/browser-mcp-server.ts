/**
 * @domain subdomain: Browser Automation
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: application
 * @domain depends: BrowserSessionManager
 *
 * In-process MCP server `funny_browser`: browser tools bound to one spawn's
 * thread and user. Tool names as seen by the model:
 * `mcp__funny_browser__browser_<name>`.
 *
 * Kept separate from the `funny` server on purpose: `funny_browser` is listed
 * in `PERMISSION_GATED_MCP_SERVERS` (sdk-claude), so its calls follow the
 * thread's permission mode instead of being auto-allowed. Tools are deferred
 * (no `alwaysLoad`) so their schemas only enter the prompt when needed.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { ResultAsync } from 'neverthrow';

import {
  actArgs,
  browserAct,
  browserClose,
  browserEvaluate,
  browserNavigate,
  browserOpen,
  browserResize,
  browserSnapshot,
  browserStatus,
  browserWaitFor,
  evaluateArgs,
  navigateArgs,
  openArgs,
  resizeArgs,
  snapshotArgs,
  waitForArgs,
  type BrowserToolContent,
  type BrowserToolContext,
  type BrowserToolError,
} from './browser-tools.js';

export const BROWSER_MCP_SERVER_NAME = 'funny_browser';

export const BROWSER_INSTRUCTIONS =
  "These tools drive a real Chromium on the user's runner — the same browser " +
  "the user watches in Funny's browser panel. Use them for any web task " +
  '(dashboards, logins, checking a deployed page) instead of opening a system ' +
  'browser or launching another browser. Flow: browser_open → browser_snapshot ' +
  '→ browser_act with a [ref=eN] from the LATEST snapshot → browser_snapshot ' +
  'again to see the result. Refs expire when the page navigates or a newer ' +
  'snapshot is taken; on a stale-ref error, take a new snapshot. Logins persist ' +
  'in the default profile. If you hit a CAPTCHA, a two-factor prompt or a ' +
  'password you do not have, stop and ask the user to complete it in the ' +
  'browser panel, then continue (use browser_wait_for to wait for it).';

type ToolOutcome = ResultAsync<BrowserToolContent[], BrowserToolError>;

interface CallToolResult {
  [key: string]: unknown;
  content: BrowserToolContent[];
  isError?: boolean;
}

function signalOf(extra: unknown): AbortSignal | undefined {
  const signal = (extra as { signal?: unknown } | undefined)?.signal;
  return signal instanceof AbortSignal ? signal : undefined;
}

/**
 * Convert a tool outcome into an MCP result. An aborted call (turn
 * interrupted) resolves immediately; the underlying browser action is bounded
 * by its own timeout.
 */
async function respond(outcome: ToolOutcome, extra: unknown): Promise<CallToolResult> {
  const signal = signalOf(extra);
  const aborted = new Promise<CallToolResult>((resolve) => {
    if (!signal) return;
    const onAbort = () =>
      resolve({
        content: [{ type: 'text', text: 'cancelled: the call was interrupted.' }],
        isError: true,
      });
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  const settled = outcome.match(
    (content): CallToolResult => ({ content }),
    (error): CallToolResult => ({
      content: [{ type: 'text', text: `${error.code}: ${error.message}` }],
      isError: true,
    }),
  );
  return Promise.race([settled, aborted]);
}

/** Build the `funny_browser` server for one spawn. */
export function buildBrowserMcpServer(threadId: string, userId: string) {
  const ctx: BrowserToolContext = { threadId, userId };
  return createSdkMcpServer({
    name: BROWSER_MCP_SERVER_NAME,
    version: '1.0.0',
    instructions: BROWSER_INSTRUCTIONS,
    tools: [
      tool(
        'browser_open',
        "Open this thread's browser (or reuse it) and optionally load a URL. The user sees it live in the browser panel.",
        openArgs,
        (args, extra) => respond(browserOpen(ctx, args), extra),
        { searchHint: 'open a web page / start the browser' },
      ),
      tool(
        'browser_navigate',
        'Load a URL in the current tab, or go back / forward / reload.',
        navigateArgs,
        (args, extra) => respond(browserNavigate(ctx, args), extra),
        { searchHint: 'go to url, back, forward, reload' },
      ),
      tool(
        'browser_snapshot',
        'Accessibility snapshot of the current page with [ref=eN] ids for browser_act. Optionally includes a screenshot.',
        snapshotArgs,
        (args, extra) => respond(browserSnapshot(ctx, args), extra),
        { searchHint: 'read the page, find elements, screenshot' },
      ),
      tool(
        'browser_act',
        'Perform one action on the page: click, double_click, hover, type, fill, select, press, scroll or drag — targeting a ref from the latest snapshot or viewport coordinates.',
        actArgs,
        (args, extra) => respond(browserAct(ctx, args), extra),
        { searchHint: 'click, type, fill a form, press a key, scroll, drag' },
      ),
      tool(
        'browser_evaluate',
        'Evaluate a JavaScript expression in the page and return its JSON result.',
        evaluateArgs,
        (args, extra) => respond(browserEvaluate(ctx, args), extra),
        { searchHint: 'run javascript in the page' },
      ),
      tool(
        'browser_wait_for',
        'Wait for text to appear or disappear, a URL, a ref to become visible, or a fixed delay.',
        waitForArgs,
        (args, extra) => respond(browserWaitFor(ctx, args), extra),
        { searchHint: 'wait for page / login to finish' },
      ),
      tool(
        'browser_status',
        "State of this thread's browser: URL, title, profile, viewport, controller, recent page errors.",
        {},
        (_args, extra) => respond(browserStatus(ctx), extra),
      ),
      tool(
        'browser_resize',
        'Set the page viewport size in CSS pixels.',
        resizeArgs,
        (args, extra) => respond(browserResize(ctx, args), extra),
      ),
      tool('browser_close', "Close this thread's browser session.", {}, (_args, extra) =>
        respond(browserClose(ctx), extra),
      ),
    ],
  });
}
