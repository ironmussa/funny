## Why

The current Codex SDK transport can report permission-like failures, but it
cannot expose an actionable approval request that Funny can resume. The UI
therefore infers a permission from error text and restarts the agent after an
approval; after more than one request it can point at the wrong action or
render the generic `Continue` control. Separately, a thread's selected
permission mode is only persisted with the next user message, so leaving and
returning to a thread discards a mode change.

We need the UI to make only promises that its transport can keep, and we need
precise, repeated per-tool approvals for Codex when a transport supports them.

## What Changes

- Persist an existing thread's permission mode immediately when the user
  changes it, so reopening the thread restores the selected mode even when no
  prompt has been sent.
- Model provider permission capability explicitly. Codex SDK threads MUST NOT
  render an actionable per-tool approval card from an inferred error; they
  instead present a clear, non-actionable recovery path.
- Add a structured pending-permission lifecycle for ACP-backed Codex: request
  identity, tool summary/input, decision options, direct response to the live
  ACP request, and stale-request handling.
- Make Codex ACP available behind a transport flag while preserving the SDK as
  the default until the structured approval flow passes its integration and
  manual smoke tests.
- Replace approval-by-agent-restart for structured requests with direct
  `allow once`, `allow always`, or `deny` responses to the original request.
  Persist project permission rules only for an explicit `always` decision.

## Capabilities

### New Capabilities

- `thread-permission-mode-persistence`: An existing thread saves a user-chosen
  permission mode immediately and reflects it consistently in every open view.
- `codex-permission-approvals`: Codex exposes a truthful permission UI and,
  when running through ACP, resolves each structured tool request precisely.

### Modified Capabilities

- None.

## Impact

- Client prompt mode selector, thread store, thread API client, and localized
  permission/waiting UI.
- Runtime thread routes and thread-service approval flow; WebSocket thread
  updates and durable pending-permission state.
- Core agent contracts, Generic ACP permission handling, Codex transport
  selection, and Codex ACP integration.
- Shared thread/permission types and database schema/repositories as needed to
  represent an active structured request safely.
- Focused client, runtime, core, and integration tests; no change to existing
  threads' provider/model data.
