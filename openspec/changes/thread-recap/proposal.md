# Proposal

## Why

Threads run unattended (long agent turns, automations, the issue factory), and a user coming back to one has to scroll the transcript to learn what happened and whether the agent is waiting on them. Claude Code solves this with a "session recap", but the Claude Agent SDK keeps it internal (`awaySummaryEnabled` is `@internal`, no public message type) and it would only cover Claude threads. funny already stores every provider's messages and tool calls in one normalized shape, so it can produce its own recap for any thread, with one summarizer model, whatever agent did the work.

## What Changes

- **Thread recap (phase A).** When the owner opens a thread that has new agent activity since they last read it, and they have been away for at least 5 minutes, the thread view shows a short, dismissible recap card above the chat: what the agent did, the state it ended in, and whether it is waiting on the user (approval, question, error). The recap is generated on the owner's runner from the thread's stored messages and tool calls, by a fixed cheap model (Claude Haiku through the Claude Agent SDK, the same pattern as commit message generation). A runner without Claude credentials shows no recap and the UI says nothing breaks.
- **Utility model (phase B).** A per-user "utility model" setting (Settings > Profile) chooses the model used for funny's small helper generations: provider (`claude-sdk` default, or an LLM API provider: `anthropic`, `openai`, `ollama`, `openai-compatible`) and model id. The recap uses it; commit message generation moves to it as well. The default keeps phase A's behavior, so nothing changes for a user who never opens the setting.
- Recaps are offered only to the thread owner, never to a steer sharee, and not for sandbox threads in this change.

## Capabilities

### New Capabilities

- `thread-recap`: when a recap is offered, what it contains, who may see it, how it is generated and cached, and how it fails.
- `utility-model`: the per-user utility model setting, its default, which helper generations use it, and how a missing credential is reported.

### Modified Capabilities

<!-- none: commit message generation has no spec today; moving it to the utility model is covered by the utility-model capability. -->

## Impact

- **runtime:** new `services/recap-generator.ts` and a `POST /api/threads/:id/recap` route; a `services/utility-model.ts` that dispatches a one-shot generation to the Claude SDK or the core LLM layer; `commit-message-generator.ts` routed through it.
- **core:** a one-shot completion helper in `agents/llm/` on top of `ModelFactory` (no tools, no agent loop).
- **shared:** `UtilityModelSetting` type and zod schema in the profile contract; `user_profiles.utility_model` column (migration).
- **server:** profile port reads/writes the setting; the runner receives it with the recap / commit request. No new data-channel type beyond what LLM API threads already use for provider keys.
- **client:** recap card in `ThreadView` (shadcn `Card`-style, `data-testid="thread-recap-card"`), `canShowRecap(thread)` predicate in `lib/thread-variant.ts`, `data/thread-recap/` query, Settings > Profile utility model section indexed in `settings-index.ts`, i18n strings (en, es, pt).
