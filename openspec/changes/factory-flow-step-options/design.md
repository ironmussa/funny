# Design

## Context

- The YAML compiler (`packages/workflows/src/compiler/yaml-compiler.ts`) already passes
  `model`, `provider`, `mode` (from `permission_mode`, through `coercePermissionMode`),
  `allowedTools` and `disallowedTools` to `ActionProvider.spawnAgent`. The server factory's
  provider (`factory-action-provider.ts`) reads only `opts.prompt`, `opts.context` and, on the
  first thread, `opts.model`. Later agent steps are follow-ups to `threadIds[0]` through
  `sendFactoryFollowUp`, whose body is just `{ content }`.
- The runtime already accepts every option we need. `createThreadSchema` takes `provider`,
  `model`, `permissionMode`, `effort`, `allowedTools`, `disallowedTools`; `sendMessageSchema`
  takes the same fields. A follow-up with a different model or provider **persists** the new
  values on the thread, clears `sessionId` and sets `contextRecoveryReason`, so the next run
  replays the thread's transcript into a fresh session
  (`thread-service/messaging.ts:collectThreadSettingUpdates`).
- Tool lists are applied only by the Claude SDK and pi providers (`core/agents/sdk-claude.ts`,
  `pi-sdk.ts`); Codex and the ACP providers ignore them.
- `before_retry` is compiled as a synthetic `spawn_agent` node with id
  `<node>-before-retry-<attempt>`; the provider never learns the node id.
- Agent steps are numbered in call order for resume (`threadIds[step]`); a replayed step that a
  later recorded step continued on the same thread counts as finished.
- The flow is loaded per run from the default branch through the App contents API
  (`factory-flow.ts`), or from `packages/workflows/defaults/`.

## Goals / Non-Goals

**Goals:**
- One resolution rule for a step's agent options, applied identically by runs and by
  Validate flow.
- No option written in a flow is ever dropped silently by the factory.
- Keep the implementing thread as the single writer to the run's branch.

**Non-Goals:**
- Supporting these options in the orchestrator's or runtime pipeline's providers (they keep
  their current behaviour; the schema change is additive for them).
- A visual flow editor or editing flow files from the UI (`add-workflow-visual-editor` covers
  editing).
- Execution profiles (accounts) per step: steps use the thread's profile as today.
- Enforcing `output_format`; it stays refused for factory flows.

## Decisions

### D1. Resolve options in one pure function, on the server

`resolveStepOptions({ stepId, step, flowDefaults, overrides, factoryDefaults })` in
`services/factory/factory-step-options.ts` returns
`{ provider, model, effort, permissionMode, allowedTools?, disallowedTools?, thread }`.
Precedence: override (provider / model / effort) → step → `defaults:` → factory defaults
(`DEFAULT_PROVIDER`, the provider's default model, `autoEdit`). Every resolved field is
explicit, so a follow-up always sends the step's full option set; this is what stops options
leaking from one step to the next, given that the runtime persists them on the thread.

Model / provider validity uses the same `validateProviderModel` rule as the runtime, via the
shared model registry, so the loader refuses an invalid pair instead of the runner answering 400
mid-run.

*Alternative:* send only the fields a step sets and let the thread keep the rest. Rejected: the
runtime persists them, so step N's model would silently become step N+1's.

### D2. Factory-specific validation is a separate pass after parsing

`packages/workflows` stays generic: the schema gains `effort`, `thread` (`continue` | `new`,
default `continue`), `prompt_file`, and a flow-level `defaults` (provider, model, effort,
permission_mode, allowed_tools, denied_tools). The factory adds `validateFactoryFlow(parsed,
overrides)` in `factory-flow.ts`, run by `loadFactoryFlow`, that walks every agent step
(nodes and `before_retry`; `on_reject` cannot occur because approvals are refused) and returns
every problem at once (`step`, `field`, `message`), which both the run failure and Validate flow
show. It refuses: fields other than `prompt` / `prompt_file` / `provider` / `model` / `effort`
/ `permission_mode` / `allowed_tools` / `denied_tools` / `thread` (so `agent` and
`output_format` are refused); permission modes other than `autoEdit` / `plan`; tool lists on a
provider without tool-policy support; `thread: new` not resolving to `plan`; `thread: new` on
the first agent step (there is no implementing thread to keep).

Tool-policy support is a small table in the factory (`claude`, `pi`) rather than a new provider
manifest field. *Alternative:* add `supportsToolPolicy` to provider manifests. Deferred: a
manifest field is the better home once a second consumer needs it; the table has a test that
fails if a listed provider's process stops reading `disallowedTools`.

`coercePermissionMode` in the compiler currently narrows to `plan | autoEdit | confirmEdit`; it
is widened to the full `PermissionMode` so the provider sees what the flow said. The factory
check, not the coercion, decides what is allowed.

### D3. The provider learns the step id

`SpawnAgentOpts` gains `stepId` (the node id; for a fix step `<node>.before_retry`, without
the attempt number, so one override covers every attempt) and `effort` and `thread`. The
compiler sets them. The factory provider calls `resolveStepOptions` with it.

### D4. `thread: new` steps

A `thread: new` step launches through the same `deps.launch` as the first step (so it lands on
the enabler's runner or sandbox, in the run's mode) with title `[Factory] #N review: …` and the
resolved options; it is recorded in `threadIds` in call order like any step. `followUp` keeps
targeting `threadIds[0]`. The resume rule "a replayed step a later step continued counts as
finished" already works: a new-thread step's id never appears later. Adoption of an interrupted
launch (`findLaunchedThread`) matches the full step title, not only the `[Factory] #N` prefix,
so a review launch is not mistaken for the implementing thread. Stop stops every recorded
thread, so review threads stop with the run.

The review thread does not check out the run's branch for writing. Its prompt tells it to read
the diff with `git fetch origin <branch> && git diff origin/<default>...origin/<branch>`, which
works in local, worktree (separate worktree, no branch checkout conflict) and sandbox modes.
`plan` mode keeps it from editing.

*Alternative:* let any step run on a new thread. Rejected for v1: two threads writing one
branch race on push and break the "the agent keeps its context" property of the fix loop.

### D5. Prompt files are resolved before compilation

`resolvePromptFiles(parsed, readFile)` in `packages/workflows` replaces each `prompt_file`
with the file's text, given a reader. Paths are normalized relative to the flow's directory and
refused when absolute, containing `..`, or outside it. The factory's reader is the same
default-branch contents read as the flow (`repositoryCopy`), so flow and prompts come from one
commit: the loader first reads the default branch's head commit, then reads flow and prompts at
that ref (not at the moving branch name), and records the commit. Built-ins read from
`defaults/prompts/`. Hosts that do not call `resolvePromptFiles` get a compile error
"prompt_file is not supported here" instead of an empty prompt.

### D6. Step overrides are stored on the factory settings row

`factory_settings.step_overrides` is a JSON object
`{ [stepId]: { provider?, model?, effort? } }`, validated by a zod schema in
`@funny/shared/contracts/factory` (strict: a permission mode or tool field fails validation)
plus `validateProviderModel`. It is read at each agent step (not snapshotted at admission), so a
change reaches steps that have not started; the spec says so. Saving needs `steer`, like the
rest of the settings. The client lists the agent steps from Validate flow's summary, so the
table shows the real step ids of the selected flow, with free entries for unknown ids marked
unused.

### D7. Recording and showing what ran

`factory_runs` gains `flow_source` (`repository` | `built-in`), `flow_commit` (nullable) and
`step_options` (JSON array of `{ stepId, threadId, provider, model, effort, permissionMode,
thread }`, appended when a step starts). Resume and retry reload the flow by name as today but
keep the recorded source/commit columns from the first start (a retry that reloads a newer
commit updates `flow_commit`, since that is what the retry runs). The run row in
`ProjectFactoryRuns.tsx` shows source, short commit (linked to the file at that commit) and a
collapsible per-step list.

### D8. Validate flow

`factory.validateFlow({ projectId, flowName })`, a `projectProcedure('view')` query in the
`factory` tRPC group, calls the same `loadFactoryFlow` + `validateFactoryFlow` +
`resolveStepOptions` with the caller's factory overrides. It answers
`{ ok: false, problems }` or `{ ok: true, source, commit, steps, unusedOverrides }`. It needs
the App token to read the repository, as the run does; without one it answers the same
actionable error. Reads only.

### D9. Built-in flow and prompt changes

- `defaults/prompts/implement.md`, `fix-ci.md`, `open-pr.md`; `issue-to-pr` and
  `issue-to-merge` reference them with `prompt_file`.
- `pull-request` gets `retry: { max_attempts: 2, should_retry: "$contains(error, 'did not open
  one')", before_retry: { prompt_file: prompts/open-pr.md } }`.
- No `issue-to-merge-reviewed` built-in. An advisory review applied by the implementer is
  not independent (the implementer decides what to apply and nobody re-checks), and it runs
  before CI, so CI fixes reach the merge unreviewed. The review that gates the merge is the
  `review` step kind of `factory-agent-roles`, which uses `thread: new` from this change.
  Repository flows can still write an advisory `thread: new` step themselves.
- The CI failure text (`factory-ci-actions.ts` over `@funny/core/github-app` pull requests)
  adds the head SHA, the check URL and, for GitHub Actions, the first failed step name from the
  job; the total stays bounded (existing 5 checks × excerpt cap). The `should_retry` strings
  (`Failing checks`, `conflicts with its base`) are kept verbatim.

## Risks / Trade-offs

- [A model change on a continuing step resets the agent session and replays the transcript,
  which costs tokens and can lose detail] → Validate flow flags consecutive continuing steps
  whose model or provider differ ("context replay"), and the built-ins keep one model on the
  implementing thread unless a member overrides it.
- [Refusing fields that today are silently ignored breaks a repository flow that sets them] →
  The refusal names step and field, Validate flow lets teams check before sending, and the
  openwiki page lists the accepted fields. This is the intent: those flows were not doing what
  they said.
- [Overrides read live can change a run mid-flight] → Only steps not yet started; recorded
  `step_options` show what each step actually used.
- [`thread: new` on a sandbox runtime starts another sandbox] → Documented cost; no built-in
  uses `thread: new` in this change.
- [Tool-policy table drifts from the providers] → Test in D2.
- [A review thread's output is model text injected into the next prompt] → It is the enabler's
  own agent output on the same repository, the same trust as today's follow-ups; issue text is
  still not inlined.

## Migration Plan

1. Migration adds the three `factory_runs` columns and `factory_settings.step_overrides`
   (nullable, default null) in `server/src/db/migrate.ts`, both schemas. Old rows show source
   "unknown".
2. Ship workflow schema + factory validation + option passing together, so no release accepts
   a field it then drops.
3. Ship prompt files and the new built-ins, then the UI.
Rollback: the columns are nullable and unused by older code; repository flows using
`prompt_file`, `thread` or `defaults` fail to load on an older server with a parse error naming
the field.
