# Providers, plugins, MCP, and the standalone services

funny's "integration surface" splits into three groups: (1) agent providers wired directly into the live app, (2) plugin/extension contracts the client and browser consume, and (3) standalone services that run as separate processes and talk to funny only over HTTP. Confusing (2)/(3) with "part of the runtime" is the most common onboarding mistake in this repo — most of them have **no in-repo consumers**.

## 1. Agent providers (wired into the live app)

Multi-provider support lives in `packages/core/src/agents/`, selected per thread via `process-factory.ts`:

- `sdk-claude.ts` — Claude via `@anthropic-ai/claude-agent-sdk`.
- `codex-acp.ts`, `gemini-acp.ts`, `cursor-acp.ts`, `opencode-acp.ts`, `generic-acp.ts` — Agent Client Protocol (ACP) stdio adapters for Codex, Gemini, Cursor, opencode, and other installed ACP-compatible CLIs. `generic-acp.ts` resolves spawn commands from the pluggable provider-manifest system in `packages/shared/src/provider-manifest*.ts`.
- `deepagent-process.ts`, `llm/llm-api-process.ts` — Deep Agent and generic LLM-API providers.

**MCP (Model Context Protocol) support** for funny's own agents is implemented server-side: `packages/runtime/src/services/mcp-service.ts`, `mcp-oauth.ts`, `services/agent-startup/load-mcp-servers.ts`, exposed via `packages/runtime/src/routes/mcp.ts`, with client-side configuration UI at `packages/client/src/components/McpServerSettings.tsx`. This is unrelated to `packages/memory`'s own separate MCP server (see below) — same protocol, two independent implementations.

### Codex transport and permission approvals

Codex uses the SDK transport by default (`FUNNY_CODEX_TRANSPORT=sdk`). The SDK can report a blocked operation but cannot receive an interactive response, so Funny shows a recovery state rather than an actionable per-tool approval.

Set `FUNNY_CODEX_TRANSPORT=acp` on the runner to opt into `codex-acp`. This requires the `codex-acp` binary to be installed and available on that runner's `PATH`; Funny fails the run with a provider setup error if it cannot start, and does not fall back to the SDK. ACP enables exact, live `allow once`, `allow always`, and `deny` responses for the current request. An `allow always` response is sent only after its Funny project rule has been persisted.

> Note: `packages/api-acp` (`@funny/api-acp`) despite its name has **nothing to do with** this ACP provider layer — see §3.

## 2. Visualizer plugins and the browser annotator

- **`packages/plugin-sdk`** is the stable, versioned public contract (`peerDependencies: react >=19`) third-party visualizer plugin authors compile against. The client's own built-in visualizers (Mermaid, CSV — see `packages/client/src/visualizers/builtin.tsx`, `host-api.ts`, `host-runtime.ts`) use the exact same `VisualizerPlugin` contract, loaded at runtime via import-map shims served from `packages/client/public/vendor/funny-plugin-sdk.mjs` / `funny-host.mjs` (see [`docs/visualizer-plugins.md`](../../docs/visualizer-plugins.md)). Third-party plugins are managed with `funny ext install/list/remove` against `~/.funny/extensions/`; the example plugin repo lives at `github.com/ironmussa/funny-extensions` (a separate repo, not in this monorepo).
- **`packages/chrome-extension`** ("Funny — UI Annotator") is a Chrome MV3 extension letting users select/annotate DOM elements on any page and send them to funny for AI analysis. It is a **sibling implementation** of the in-app "Browser Annotator Panel" feature (driven by Playwright/CDP screencasting: `packages/runtime/src/services/browser-session-manager.ts`, `packages/client/src/components/browser-panel/`) — the two share only a small DOM-extraction helper module, `packages/shared/src/dom/extract.ts`. Building/loading the extension is a separate step from running funny itself.

## 3. Standalone services (separate processes, HTTP-only coupling)

None of the packages below are imported by `client`, `server`, or `runtime`. They run as independent processes and, where they integrate at all, do so over HTTP against funny's ingest API or against each other.

| Package | What it does | How it talks to the rest of the system |
| --- | --- | --- |
| `packages/agent` (`@funny/orchestrator`, port 3002 by default) | Autonomous GitHub issue → merged PR pipeline: plans, spawns coding agents in worktrees, runs quality checks, opens PRs, handles CI failures, escalates to humans. | Registers `packages/api-acp` as an LLM provider over HTTP; reports events back to funny's ingest webhook via `@funny/sdk`'s `FunnyClient` (`src/adapters/outbound/ingest-webhook.adapter.ts`) |
| `packages/api-acp` (`@funny/api-acp`, port 4010 by default) | Exposes the Claude Agent SDK's `query()` as a run-based HTTP protocol (`POST /v1/runs`, `GET /v1/models`), reusing the CLI's own auth instead of API keys. | Consumed only by `packages/agent` over `http://localhost:4010` |
| `packages/reviewbot` (`@funny/reviewbot`) | Fetches a GitHub PR diff, sends it to the Anthropic API, posts a structured review via `gh pr review`. Runs its own Hono server receiving GitHub webhooks directly. | Reports results into funny's ingest API via `@funny/sdk` |
| `packages/memory` (`@funny/memory`, "Paisley Park") | Standalone project-memory system: semantic search, temporal decay, LLM-powered consolidation over a libSQL store. Own REST API (:4020) and its own MCP server (stdio). | No integration found anywhere in the app — treat as an independent tool today |
| `packages/harness` (`@funny/harness`) | Experimental public SDK for authoring agents/sessions/tools/workflows without importing the full server/runtime app; wraps `@funny/pipelines` + `@funny/core`. | No consumers yet; its own README notes the package name may change before an npm publish |
| `packages/design-client` (`@funny/design-client`) | "Open Design" — a planned open-source clone of Claude Design for AI-driven visual prototyping (HTML+Tailwind output). | Spec-only (`docs/open-design.md`), no `src/` implementation yet |
| `packages/sdk` (`@funny/sdk`) | Thin client (`FunnyClient`) that the four packages above use to call funny's ingest webhook API. | The glue, not a feature on its own |

If you're new to the repo and see one of these packages referenced in an issue or PR, check this table before assuming it's part of the running client/server/runtime app — most of them are separately deployed tools that happen to live in the same monorepo.
