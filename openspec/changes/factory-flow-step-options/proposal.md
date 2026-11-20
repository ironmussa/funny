# Proposal

## Why

A factory flow cannot say how each of its agent steps runs. `spawn_agent` accepts `provider`,
`permission_mode`, `allowed_tools` and `denied_tools`, and the server factory ignores all of them
without a word (only the first step's `model` is applied), so a flow that writes
`denied_tools: [Bash]` looks restricted and is not. Every step after the first is a follow-up
on the implementing thread with that thread's settings, so a team cannot run the implementation
on one model, the CI fix on a cheaper one and a review on a different provider. Runs are also
lost for avoidable reasons (the agent forgets to open the pull request), the built-in prompts
are copied between flows, and nobody can see which flow, from where, a run used or whether a
repository's flow file is valid until an issue fails on it.

## What Changes

- **Per-step agent options.** Every agent step (including `retry.before_retry`) can set
  `provider`, `model`, `effort`, `permission_mode`, `allowed_tools` and `denied_tools`, and the
  factory applies them to that step only: on the new thread for the first step, and on the
  follow-up message for later steps. A flow-level `defaults:` block sets them for every agent
  step. Options do not leak from one step to the next.
- **Per-factory step overrides from the UI.** In the factory settings a member with `steer` can
  pick, per agent step of the factory's flow, the provider, model and effort (not the
  permission mode or tools, which stay in the reviewed flow file). Overrides win over the flow.
- **Refuse what cannot be honoured.** A factory flow that uses an option or value the factory
  cannot apply is refused when it loads, with a message naming the step and the field, instead
  of running with the option silently dropped. Permission modes that wait for a human
  (`ask`, `confirmEdit`) and `auto` are refused; `autoEdit` (today's behaviour) and `plan` are
  accepted.
- **Separate review threads.** An agent step can set `thread: new` to run on its own thread
  instead of continuing the implementing one. Such a step must be read-only (`permission_mode:
  plan`); its output reaches later steps through `{{<step>.output}}`. This lets a different
  provider review the change without two agents writing to the branch.
- **Shared prompt files.** `prompt_file:` loads a step's prompt from a file next to the flow
  (`.funny/workflows/prompts/…` on the default branch, or the built-in `prompts/` directory),
  so `issue-to-pr` and `issue-to-merge` share one implement prompt.
- **Built-in flows improved.**
  - The `pull-request` step retries once, asking the same agent to push and open the pull
    request when it finished without one.
  - The implement prompt asks the agent to read the repository's agent instructions, to scope
    an ambiguous or large issue to its smallest useful part, and to write a pull request body
    with what changed, how it was tested and the decisions it made.
  - The CI fix prompt asks the agent to reproduce the failure first and, on the last attempt,
    to fix only the failure or explain why it cannot.
  - The failing-check context handed to the fix step (today: names and a bounded log tail)
    also names the commit that was checked, the failed job step when GitHub Actions reports
    it, and a link to the check.
  - No reviewed built-in here: the independent review that gates the merge is the `review`
    step of `factory-agent-roles`, which builds on `thread: new`.
- **Flow visibility.** A run records where its flow came from (repository or built-in), the
  default-branch commit it was read at and the effective options of each agent step; the run
  row shows them. The factory settings get a **Validate flow** action that loads the selected
  flow exactly as a run would and shows the error or a summary of its steps.

## Capabilities

### New Capabilities

<!-- None: everything here is the issue factory's behaviour. -->

### Modified Capabilities

- `issue-factory`: flows gain per-step agent options, flow-level defaults, per-factory step
  overrides, `thread: new` read-only steps and prompt files; a flow using an option the factory
  cannot apply is refused at load; runs record their flow source, commit and per-step options;
  flows can be validated before a run; the built-in flows recover a missing pull request and
  ship the improved prompts.

## Impact

- **`packages/workflows`**: `spawn_agent` schema (`effort`, `thread`, `prompt_file`), flow-level
  `defaults`, step id passed to the action provider, prompt-file resolution helper, built-in
  flows and a `prompts/` directory, the CI failure formatting used for `LAST_ERROR`.
- **`packages/server/src/services/factory/`**: `factory-flow.ts` (factory-specific validation,
  prompt files from the default branch, source / commit), `factory-action-provider.ts`
  (options on launch and follow-up, `thread: new`, overrides), `factory-thread-requests.ts`
  (follow-up body carries options), `factory-flow-runs.ts` (recording), `factory-settings.ts`
  (step overrides), `factory-ci-actions.ts` / `factory-pull-requests.ts` (failure context).
- **Database**: `factory_settings.step_overrides` (JSON) and `factory_runs.flow_source`,
  `flow_commit`, `step_options` (JSON); migration in `server/src/db/migrate.ts`, both schemas.
- **API**: `factory` tRPC group gains `validateFlow` and the step overrides in the settings
  input / output (`@funny/shared/contracts/factory`).
- **Client**: factory settings (step overrides table, Validate flow), run row (flow source,
  commit, per-step options).
- **Runtime**: none required; the thread-creation and follow-up endpoints already accept
  provider, model, effort, permission mode and tool lists. A model or provider change on a
  follow-up already resets the agent session and replays the thread's context.
- **Docs**: `openwiki/architecture/issue-factory.md`, the comments of the built-in flows.
