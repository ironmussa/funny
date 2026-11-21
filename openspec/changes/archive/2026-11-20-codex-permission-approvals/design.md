## Context

Funny currently represents a permission request indirectly: an adapter emits a
synthetic tool result or an error string, `AgentMessageHandler` infers a
pending permission, and the client invokes `/approve-tool`. That endpoint
restarts the agent with an English approval message. This is adequate only
when the provider accepts an allowed-tool list or can re-evaluate a saved rule
on resume.

`@openai/codex-sdk` 0.144 starts `codex exec --experimental-json`, writes one
prompt to stdin, and closes it. Its event union contains no permission-request
event or response operation. Its `on-request` policy can therefore produce a
failure Funny recognizes, but Funny cannot resume that request. In contrast,
the retained `CodexACPProcess` receives ACP `session/request_permission`
requests with a tool call and available option ids. Its current implementation
still pauses by returning a promise that is released when the process is
aborted, so the existing restart endpoint cannot provide an exact one-time
approval either.

The repository already has a manifest-backed ACP process and a separate Codex
SDK process. This change makes the selected transport's capabilities explicit
instead of presenting a provider-neutral UI that only one transport can honor.

## Goals / Non-Goals

**Goals:**

- Save a thread permission-mode selection immediately and broadcast the saved
  value to every open view.
- Never present an inferred Codex SDK error as an actionable per-tool approval.
- Support repeated, exact `allow once`, `allow always`, and `deny` decisions
  for a live Codex ACP permission request without restarting its agent.
- Preserve enough pending-request state for reloads, authorization checks, and
  clear recovery after the runner loses the live continuation.
- Introduce ACP as an opt-in Codex transport first, with testable criteria for
  making it the default later.

**Non-Goals:**

- Do not scrape a Codex terminal/PTY prompt or parse its human-facing output.
- Do not silently convert a per-tool approval into `autoEdit` or
  danger-full-access for the rest of the turn.
- Do not change Claude, Gemini, Cursor, Pi, or OpenCode permission semantics.
- Do not make an existing SDK-backed Codex session switch transports mid-turn.
- Do not persist or reuse a live ACP continuation across a runner restart.

## Decisions

### D1 — Permission capability is transport-specific and client-visible

Introduce a resolved permission capability for the effective agent transport:

```ts
type PermissionApprovalCapability =
  | { kind: 'structured'; transport: 'codex-acp' }
  | { kind: 'unavailable'; reason: 'codex-sdk-no-interactive-approval' };
```

The runtime supplies this capability with thread init/status data. The client
uses it to decide whether an error can render an approval card. A Codex SDK
thread may still report a blocked operation, but it renders an explanatory
recovery card, not `PermissionApprovalCard` or the generic `Continue` action.

Alternative: keep the error-text heuristic and improve its regex. Rejected:
no regex supplies the missing request id and continuation, so it can only make
the misleading flow look more convincing.

### D2 — Persist a mode change through a dedicated thread update

Add an owner-authorized endpoint that accepts only a valid `PermissionMode`
for an existing thread. The prompt selector optimistically updates the thread
store, persists the value immediately, and rolls back with an error toast if
the request fails. The runtime emits the normal thread update event so the
sidebar, main view, mobile view, and live columns converge.

Changing the setting does not mutate an already-running agent's sandbox. It is
the mode for the next execution/resume. This prevents a selector from implying
that a process has been elevated or restricted while it is already executing.

Alternative: save only on the next user message. Rejected because navigation
and reload can discard a deliberate choice, which is the reported defect.

### D3 — Structured requests have durable metadata and a live continuation

Add a pending-permission repository record with a unique request id, thread id,
run/session generation, provider/transport, tool call id, display-safe tool
input, available allow/reject option ids, status, and timestamps. At most one
request can be active for a thread/run.

`GenericACPProcess` gains a provider-agnostic `respondToPermission(requestId,
decision)` operation. On ACP `session/request_permission`, it registers a
resolver in memory, emits a structured permission-request message, and waits.
The message handler persists the record, marks the thread `waiting` with
reason `permission`, and emits the precise request to the client. It does not
manufacture a denial text or wait for the turn to terminate.

`/approve-tool` is extended (or replaced by a versioned structured approval
route) to require the request id and decision. It authorizes the thread owner,
validates that the request is still active for the current run, calls the live
resolver, and transitions the durable record to resolved. A stale or unknown
request returns a conflict and the client refreshes thread state.

Alternative: store only a tool call with a null output. Rejected because a
null output also means an interrupted or incomplete tool, and cannot identify
the provider's precise allow/reject option.

### D4 — `once`, `always`, and `deny` preserve their exact scope

- `allow once` selects ACP's `allow_once` option and creates no Funny rule.
- `allow always` requires a provider `allow_always` option and a successfully
  persisted Funny project rule before selecting the provider option. If rule
  persistence fails, the request remains pending and the user can choose
  `allow once` rather than being told a non-persistent approval is permanent.
- `deny` selects ACP's `reject_once` (or the provider's available reject)
  option and creates no allow rule.

The response is delivered to the same pending ACP request; it never starts a
new prompt, kills the current process, or relies on a natural-language message
to ask Codex to repeat the action.

Alternative: after any approval start a new process in `autoEdit`. Rejected:
it is a wider escalation than the UI describes and cannot distinguish one
command from subsequent operations.

### D5 — Codex ACP rolls out behind an explicit transport flag

Add `FUNNY_CODEX_TRANSPORT=sdk|acp`; the default remains `sdk` for this
change. When `acp` is selected and `codex-acp` is available, the process
factory uses `CodexACPProcess`; otherwise startup fails with a provider setup
error rather than falling back silently to a different permission model.

The SDK path remains supported for plan and non-interactive execution, but its
ask/confirm modes expose the unavailable-approval recovery UI from D1. Once
the ACP matrix passes in CI and a manual smoke test proves repeated approvals
against a real `codex-acp` binary, a future change can make ACP the default.

Alternative: immediately replace the SDK globally. Rejected because transport
differences (resume, images, tool rendering, authentication, and availability)
need a controlled rollout and rollback path.

### D6 — Runner loss invalidates, rather than reconstructs, a live request

The resolver exists only in the live process. On runner restart, process exit,
or run-generation mismatch, the runtime expires the durable pending request,
clears the permission card, and surfaces a provider-recovery state explaining
that the action was not approved. Retrying starts a new agent execution, which
may request permission again with a new request id.

Alternative: rebuild a request from the last 25 tool calls and error text.
Rejected because it can bind a user decision to a stale or unrelated operation.

## Risks / Trade-offs

- [ACP binary/version differs by runner] → Keep ACP opt-in, run capability
  probes at startup, and fail clearly when `codex-acp` is unavailable.
- [A user clicks an old approval card] → Require request id and active run
  generation; return a conflict and refresh instead of forwarding a decision.
- [Runner restart loses an in-memory resolver] → Expire the durable request
  and offer a clearly labelled retry, never a false approval.
- [Persisting `always` rules fails] → Leave the request pending and preserve
  the valid `allow once` option; never claim an always rule was saved.
- [A running process does not reflect a mode change] → State this in the UI
  and apply the persisted mode only to the next execution/resume.
- [New state creates migration complexity] → Use an additive table/repository
  and leave historical threads with no pending record.

## Migration Plan

1. Add the permission-mode update API and optimistic client persistence; it is
   independently deployable and backward-compatible.
2. Add shared structured request types, durable storage, runner APIs, and
   client rendering while the Codex SDK reports `unavailable`.
3. Add the ACP continuation implementation and transport flag. Enable it only
   in development/selected runners, then run the focused integration matrix.
4. Enable ACP per deployment after manual smoke validation. Keep the SDK flag
   as an immediate rollback; expire any ACP request during a transport switch.
5. Consider changing the default in a later proposal only after production
   evidence shows no regressions in Codex execution behavior.

## Open Questions

- Should the structured endpoint retain `/approve-tool` for compatibility or
  use `/permission-requests/:id/respond` and deprecate the old heuristic path?
- Does the deployed `codex-acp` version expose both `allow_always` and
  `reject_once` options consistently? The implementation must probe and test
  the actual option set rather than assume it.
- Which non-sensitive fields of a permission input are safe to persist and
  show to collaborators with thread access? The initial implementation should
  reuse the current sanitized tool-input serializer.
