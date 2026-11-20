# Design

## Context

- Fenced blocks in assistant messages already go through a visualizer registry: `lib/markdown-components.tsx` calls `getVisualizerForFence(lang)` (`lib/visualizer-registry.ts`). Built-ins are registered in `visualizers/builtin.tsx` and lazy-loaded behind their own `Suspense`. The contract (`VisualizerProps`: `source`, `fill`, `src`) lives in `@funny/plugin-sdk`.
- `VisualizerProps` carries neither the thread id nor whether the message is still streaming. Both are needed here: the thread id for `followUp`, the streaming flag to suppress errors on partial specs.
- The runtime tells agents about mermaid through the `WATCH_INSTRUCTIONS` string in `packages/runtime/src/services/agent-watch-tool.ts` (funny MCP server instructions).
- The client may only import types from `packages/shared`. `packages/ui-contracts` is a renderer-neutral package the client already depends on, and the runtime can depend on it too.
- The message list is virtualized with measured heights (`MemoizedMessageList.*`), and a block that grows while streaming already happens with code blocks.

## Goals / Non-Goals

**Goals:**

- One catalog definition that drives both the renderer and the agent prompt.
- Zero cost for threads that never use the fence (lazy chunk).
- Actions limited to a user-clicked follow-up through the existing route.

**Non-Goals:**

- Changing `@funny/plugin-sdk`'s public contract for third-party visualizers. The extra context is host-internal.
- Using `@json-render/shadcn` wholesale. We map to our own `components/ui/*` so theme, font scale, and `data-testid` rules hold.
- GPUIX client support. Unknown fences there keep falling back to code.

## Decisions

### D1. Plug in as a fence visualizer, not as a thread renderer

Register `@funny/visualizer-json-render` for fence `json-render` in `registerBuiltinVisualizers()`. The thread, tool cards, and data layer stay as they are.
_Alternative:_ render whole messages or turns from specs. Rejected: our events are already typed, and json-render's state/action model would compete with TanStack DB and Zustand (see the earlier discussion summarised in proposal.md).

### D2. Catalog lives in `@funny/ui-contracts/generative-ui`

`defineCatalog` (from `@json-render/core`) with Zod prop schemas for: `Card`, `Stack` (row/column, gap), `Heading`, `Text`, `Table` (columns + rows of strings/numbers), `Stat` (label, value, delta?), `Badge` (variant), `Alert` (variant, title, body), `Button` (label, variant, action). Action names: `followUp` (`{ prompt: string }`, max length bounded) and `setState`. The module exports `generativeUiCatalog` and `generativeUiPromptHint()`, which wraps json-render's catalog prompt generation and adds a short fence-usage preamble.
_Alternatives:_ putting it in `packages/shared` (the client may not import its runtime code), or hand-writing the prompt in the runtime (it would drift; the spec requires generation).

### D3. Client registry maps catalog to shadcn components

`visualizers/json-render/registry.tsx` uses `defineRegistry`, with each entry implemented over `@/components/ui/*`, `cn()`, theme tokens, `PROSE_FONT_SIZE_PX` / `CODE_FONT_SIZE_PX`, and `data-testid="genui-<type>-<index>"`. Text props are rendered as React children only (never `dangerouslySetInnerHTML`). The visualizer component and the registry are loaded with `lazy()`, like `MermaidBlock`.

### D4. Host-internal render context for thread id and streaming state

Add a small React context, `MessageRenderContext` (`{ threadId, isStreaming, canSendFollowUp }`), provided where assistant message content is rendered (`MessageContent` / `FrozenMessage`). Built-in visualizers may read it. `VisualizerProps` stays unchanged, and third-party plugins simply do not see it.
`canSendFollowUp` comes from the same predicate the prompt input uses to enable sending (ownership / steer share / not frozen), so it covers the read-only scenario.
_Alternative:_ adding fields to `VisualizerProps`. Rejected for now: it changes the public SDK for a single built-in consumer.

### D5. Parsing and streaming

- When `isStreaming` is true, feed the block source to json-render's SpecStream compiler and render the partial result, with no error UI.
- When it is false, do a strict parse plus catalog validation. On failure, show `Alert` plus the raw source as a normal code block (the same component markdown uses for unknown fences).
- Each element is wrapped in an error boundary, so one bad element never takes down the block or the message.
- Unknown types render a small "unsupported component: X" notice. Unknown actions resolve to an inert handler.

### D6. Action execution

`followUp` calls the existing send-follow-up path used by the prompt input (`lib/api/threads.ts`, via the thread actions), so optimistic UI, auth, and the steer-share allow-list apply unchanged. A click guard disables the button while the send is pending, which prevents double sends. `setState` stays local to the block's json-render state provider. Nothing executes on mount.

### D7. Agent hint

`agent-watch-tool.ts` builds its instructions as `WATCH_INSTRUCTIONS + ' ' + generativeUiPromptHint()`. To keep tokens down, the hint is compact (component signatures, not long prose), and a unit test caps its length.

## Risks / Trade-offs

- [Bundle size of json-render + zod in the client] → lazy chunk loaded only when the fence appears. Check chunk size in the build output.
- [Layout shift while a spec streams inside the virtualized list] → render inside a container that keeps its last measured min-height until the message finishes. This reuses the existing measurement path, since code blocks already grow.
- [Prompt-injection: a spec crafted to make the user send a harmful follow-up] → the button shows the exact prompt in a tooltip, sending needs a click, and it goes through the same route as typed input. It carries no more power than the agent already has by suggesting text.
- [Model over-uses UI for simple answers] → the hint says to use it only when a table, stats, or choices beat prose, the same framing as mermaid.
- [json-render API churn (young project)] → pin exact versions, and keep all json-render imports inside `ui-contracts/generative-ui` and `client/src/visualizers/json-render/`.

## Migration Plan

Additive. No data or schema changes. Rollback means removing the registration and the hint line. Old messages that contain the fence then fall back to code-block rendering.
