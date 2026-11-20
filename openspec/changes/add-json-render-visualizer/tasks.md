# Tasks

## 1. Dependencies

- [ ] 1.1 Add pinned `@json-render/core` and `zod` to `packages/ui-contracts`, and pinned `@json-render/core` + `@json-render/react` to `packages/client`; verify `bun install` succeeds and `bun run typecheck` stays green

## 2. Catalog contract (`@funny/ui-contracts/generative-ui`)

- [ ] 2.1 Add `src/generative-ui.ts` with `generativeUiCatalog` (Card, Stack, Heading, Text, Table, Stat, Badge, Alert, Button; actions `followUp` with a bounded `prompt`, plus `setState`) and export it as `./generative-ui` in `package.json`; verify with a unit test that valid props parse and invalid ones are rejected for each component
- [ ] 2.2 Add `generativeUiPromptHint()` (fence preamble + catalog prompt); verify with tests that every catalog component and action name appears in the hint, that a component removed from a test catalog disappears from it, and that the hint length stays under the agreed cap

## 3. Agent hint (runtime)

- [ ] 3.1 Add `@funny/ui-contracts` to `packages/runtime` and append `generativeUiPromptHint()` to the MCP instructions in `services/agent-watch-tool.ts`; verify with a runtime unit test that the instructions contain the `json-render` fence and the catalog component names

## 4. Render context (client)

- [ ] 4.1 Add `MessageRenderContext` (`threadId`, `isStreaming`, `canSendFollowUp`) and provide it from assistant message rendering (`MessageContent`, `FrozenMessage`), deriving `canSendFollowUp` from the prompt-input send predicate; verify with a component test that a consumer reads the right values for an owned thread, a view-only share, and a frozen thread

## 5. json-render visualizer (client)

- [ ] 5.1 Implement `src/visualizers/json-render/registry.tsx` mapping each catalog entry to `@/components/ui/*` with `cn()`, theme tokens, font-size constants and `data-testid="genui-<type>-<index>"`; verify with a component test that each component renders, that HTML in text props shows as literal text, and that it re-renders on theme/font-size change
- [ ] 5.2 Implement `JsonRenderVisualizer` with streaming (SpecStream partial, no error UI) and completed (strict parse + validation, Alert + raw code fallback) modes, per-element error boundaries, and unknown-type notices; verify with tests for a valid spec, malformed JSON, an unknown type, invalid props, and a partial spec mid-stream showing no error
- [ ] 5.3 Wire actions: `followUp` → existing thread follow-up send (click-only, pending guard, prompt shown in tooltip, disabled when `!canSendFollowUp`); unknown actions inert; `setState` local; verify with tests that a click sends exactly one follow-up with the prompt, that mount/re-render sends nothing, that unknown actions do nothing, and that buttons are disabled for read-only viewers
- [ ] 5.4 Register `@funny/visualizer-json-render` for fence `json-render` in `visualizers/builtin.tsx` behind `lazy()` + `Suspense`; verify with a markdown-components test that ` ```json-render ` dispatches to it while ` ```json ` and ` ```mermaid ` keep their current rendering
- [ ] 5.5 Add a Storybook story with sample specs (comparison table, stats, choice buttons) in light and dark; verify it renders in `bun run build-storybook` (or the repo's story test runner)

## 6. Docs

- [ ] 6.1 Document the fence, the catalog and the action rules in the openwiki integrations/visualizers page and `packages/client/CLAUDE.md` (where to add a catalog component: ui-contracts schema + client registry entry); verify the documented file paths exist

## 7. Integration checks

- [ ] 7.1 Run `bun run lint`, `bun run typecheck` and the client/runtime/ui-contracts test suites; verify all pass
- [ ] 7.2 Run `bun run build` and confirm json-render sits in a lazy chunk, not the entry chunk (inspect the Vite build output)
- [ ] 7.3 Run `fallow audit --format json --quiet --explain --gate-marker agent` and verify the verdict is not `fail`
