# Proposal

## Why

Agents can only answer in prose, code, and the few fenced formats funny renders (` ```mermaid `, ` ```csv `). Comparisons, run summaries, or a "pick one of these options" step end up as long markdown that is hard to scan and impossible to act on. [json-render](https://github.com/vercel-labs/json-render) lets a model emit a JSON UI spec built ONLY from a catalog we define. That gives us rich, interactive answers inside the existing chat. The thread pipeline, virtualized list, and data layer stay as they are.

## What Changes

- A new built-in visualizer for the ` ```json-render ` fence. It renders the spec with a funny-owned catalog of shadcn/ui-backed components (Card, Stack, Heading, Text, Table, Stat, Badge, Alert, Button). It plugs into the existing visualizer registry, the same path mermaid and CSV use.
- The catalog is the only vocabulary. Unknown component types, invalid props, or malformed JSON degrade to an inline error with the raw source. They never throw out of the message.
- A closed action set: `followUp` (sends a prompt as a follow-up in the same thread, after the user clicks) and json-render's local `setState`. No action can reach the runner, git, files, or network except through the normal follow-up message path.
- Partial specs that arrive while the assistant message is still streaming render progressively. Layout shifts inside the virtualized message list stay bounded.
- The agent hint the runtime already injects (the funny MCP server instructions that mention mermaid) gains a short description of the fence and the catalog, generated from the catalog definition so the two cannot drift apart.
- The renderer is lazy-loaded and stays out of the boot chunk.

Out of scope: replacing how the thread itself is rendered, forms that submit structured data, third-party catalog extensions, and json-render in the GPUIX client.

## Capabilities

### New Capabilities

- `chat-generative-ui`: rendering model-authored ` ```json-render ` UI specs in chat messages: catalog-bounded components, closed actions, failure handling, streaming behaviour, and the agent-facing hint.

### Modified Capabilities

<!-- None: the visualizer registry has no spec; this adds a fence to it without changing its contract. -->

## Impact

- **Client** (`packages/client`): new visualizer in `src/visualizers/` registered from `registerBuiltinVisualizers()`. New dependencies `@json-render/core` and `@json-render/react`. Follow-up dispatch reuses the existing thread message API (`src/lib/api/threads.ts`).
- **Catalog contract** (`packages/ui-contracts`): renderer-neutral catalog definition (component names, Zod prop schemas, action names) plus prompt generation. `zod` and `@json-render/core` are added here.
- **Runtime** (`packages/runtime`): `agent-watch-tool.ts` appends the generated catalog hint to the MCP server instructions. This adds a dependency on `@funny/ui-contracts`.
- **Security:** model-authored content triggers actions only through a user click, and only via the existing follow-up route, which keeps its auth and steer-share rules. Nothing is rendered as raw HTML.
- **Docs:** `openwiki` integrations page for visualizers, and `packages/client/CLAUDE.md`.
