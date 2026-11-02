/**
 * @domain subdomain: Browser Automation
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: application
 * @domain depends: BrowserSessionManager
 *
 * The `funny_browser` tools, bound to one spawn's thread and user, and the
 * instructions the agent sees. Tool names as seen by the model:
 * `mcp__funny_browser__browser_<name>`.
 *
 * Served to every agent alike over loopback HTTP (`agent-mcp-http.ts`), so
 * the browser does not depend on which agent a thread uses. Kept separate
 * from the `funny` server on purpose: `funny_browser` is listed in
 * `PERMISSION_GATED_MCP_SERVERS` (sdk-claude), so Claude's calls follow the
 * thread's permission mode instead of being auto-allowed.
 */

import type { ResultAsync } from 'neverthrow';

import type {
  AgentMcpServerSpec,
  AgentToolDefinition,
  AgentToolResult,
} from '../agent-mcp-http.js';
import {
  actArgs,
  browserAct,
  appearanceArgs,
  browserClose,
  browserDialog,
  browserRecordingStart,
  browserRecordingStop,
  browserSetAppearance,
  dialogArgs,
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

type CallToolResult = AgentToolResult;

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

/** The tools of `funny_browser`, bound to one spawn's thread, user and paths. */
function browserToolDefinitions(ctx: BrowserToolContext): AgentToolDefinition[] {
  return [
    {
      name: 'browser_open',
      description:
        "Open this thread's browser (or reuse it) and optionally load a URL. The user sees it live in the browser panel.",
      schema: openArgs,
      run: (args, extra) => respond(browserOpen(ctx, args), extra),
    },
    {
      name: 'browser_navigate',
      description: 'Load a URL in the current tab, or go back / forward / reload.',
      schema: navigateArgs,
      run: (args, extra) => respond(browserNavigate(ctx, args), extra),
    },
    {
      name: 'browser_snapshot',
      description:
        'Accessibility snapshot of the current page with [ref=eN] ids for browser_act. Optionally includes a screenshot.',
      schema: snapshotArgs,
      run: (args, extra) => respond(browserSnapshot(ctx, args), extra),
    },
    {
      name: 'browser_act',
      description:
        'Perform one action on the page: click, double_click, hover, type, fill, select, press, scroll or drag — targeting a ref from the latest snapshot or viewport coordinates.',
      schema: actArgs,
      run: (args, extra) => respond(browserAct(ctx, args), extra),
    },
    {
      name: 'browser_evaluate',
      description: 'Evaluate a JavaScript expression in the page and return its JSON result.',
      schema: evaluateArgs,
      run: (args, extra) => respond(browserEvaluate(ctx, args), extra),
    },
    {
      name: 'browser_wait_for',
      description:
        'Wait for text to appear or disappear, a URL, a ref to become visible, or a fixed delay.',
      schema: waitForArgs,
      run: (args, extra) => respond(browserWaitFor(ctx, args), extra),
    },
    {
      name: 'browser_status',
      description:
        "State of this thread's browser: URL, title, profile, viewport, controller, recent page errors.",
      schema: {},
      run: (_args, extra) => respond(browserStatus(ctx), extra),
    },
    {
      name: 'browser_resize',
      description: 'Set the page viewport size in CSS pixels.',
      schema: resizeArgs,
      run: (args, extra) => respond(browserResize(ctx, args), extra),
    },
    {
      name: 'browser_dialog',
      description:
        'Accept or dismiss the open JavaScript dialog (alert, confirm, prompt, beforeunload).',
      schema: dialogArgs,
      run: (args, extra) => respond(browserDialog(ctx, args), extra),
    },
    {
      name: 'browser_set_appearance',
      description: 'Emulate the light or dark colour scheme for the page.',
      schema: appearanceArgs,
      run: (args, extra) => respond(browserSetAppearance(ctx, args), extra),
    },
    {
      name: 'browser_recording_start',
      description: 'Start recording the browser viewport to a video.',
      schema: {},
      run: (_args, extra) => respond(browserRecordingStart(ctx), extra),
    },
    {
      name: 'browser_recording_stop',
      description: 'Stop the recording and save it as an MP4 in the assets directory.',
      schema: {},
      run: (_args, extra) => respond(browserRecordingStop(ctx), extra),
    },
    {
      name: 'browser_close',
      description: "Close this thread's browser session.",
      schema: {},
      run: (_args, extra) => respond(browserClose(ctx), extra),
    },
  ];
}

/** The `funny_browser` server as served to every agent (`agent-mcp-http.ts`). */
export const BROWSER_MCP_SERVER: AgentMcpServerSpec = {
  name: BROWSER_MCP_SERVER_NAME,
  instructions: BROWSER_INSTRUCTIONS,
  tools: browserToolDefinitions,
};
