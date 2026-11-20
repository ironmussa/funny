# Spec Delta

## ADDED Requirements

### Requirement: Agent steps run with their own options

Each agent step of a factory flow, including a `retry.before_retry` fix step, SHALL run with
the provider, model, effort, permission mode, allowed tools and denied tools resolved for that
step, in this order of precedence: the factory's step override (provider, model, effort only),
the step's own fields, the flow's `defaults:`, then the factory's existing defaults. The options
SHALL apply to that step only: a later step that sets none of them SHALL run with the resolved
options of its own (from `defaults:` or the factory defaults), not with those of the step before
it. A step that continues the implementing thread SHALL carry its options on the follow-up
message; the first step SHALL carry them on the new thread.

#### Scenario: A fix step runs on a different model than the implementation
- **WHEN** a flow's implement step sets `model: opus` and its `before_retry` sets `model: sonnet`, and CI fails
- **THEN** the fix runs on the implementing thread with `sonnet`, and the implementation ran with `opus`

#### Scenario: Options do not leak to the next step
- **WHEN** a flow sets `defaults: { model: sonnet }`, a middle agent step sets `model: opus`, and a later agent step sets no model
- **THEN** the later step runs with `sonnet`

#### Scenario: Tool restrictions are applied
- **WHEN** an agent step sets `denied_tools: [WebFetch]`
- **THEN** that step's agent runs without `WebFetch`

### Requirement: A factory flow that uses an option the factory cannot apply is refused

When a factory flow is loaded, the system SHALL refuse it, with a message naming the step and
the field, if any agent step uses a field or value the factory does not apply. Permission
modes that wait for a person (`ask`, `confirmEdit`) and `auto` SHALL be refused; `autoEdit`
and `plan` SHALL be accepted. A step whose resolved provider does not apply tool lists SHALL
be refused when it sets `allowed_tools` or `denied_tools`, so a restriction is never silently
dropped. A refused flow SHALL fail the run before any thread starts, as a
missing flow does. A flow that the factory used to accept and that sets only fields the factory
applies SHALL keep loading.

#### Scenario: An unsupported permission mode is refused
- **WHEN** a repository's `issue-to-merge.yaml` sets `permission_mode: ask` on its implement step
- **THEN** the run fails before starting a thread with a message naming the step `implement` and the field `permission_mode`

#### Scenario: An unknown agent field is refused
- **WHEN** an agent step sets `output_format`
- **THEN** the flow is refused with a message naming the step and `output_format`

#### Scenario: A tool list on a provider that cannot apply it is refused
- **WHEN** an agent step sets `provider: codex` and `denied_tools: [Bash]`
- **THEN** the flow is refused with a message naming the step, `denied_tools` and the provider

#### Scenario: Today's built-in flows still load
- **WHEN** the factory loads the built-in `issue-to-merge` or `issue-to-pr`
- **THEN** the flow loads without error

### Requirement: Factory members override step options per factory

A member with `steer` on the project SHALL be able to set, for their factory, a provider,
model and effort per agent step id of the factory's flow, and SHALL NOT be able to set a
permission mode or tool lists this way. An override SHALL be validated as a provider / model
pair the system supports. An override for a step id the run's flow does not have SHALL be
ignored and reported by flow validation. Overrides SHALL apply to runs admitted after they
are saved and to steps that have not started yet.

#### Scenario: A member picks a cheaper model for the CI fix
- **WHEN** a member sets the override `ci.before_retry → model: haiku` and a later run's CI fails
- **THEN** the fix step runs with `haiku` even though the flow file says another model

#### Scenario: A permission mode cannot be overridden from settings
- **WHEN** a client sends a step override that carries a permission mode
- **THEN** the settings save is refused with a validation error

#### Scenario: A viewer cannot change overrides
- **WHEN** a project member without `steer` saves step overrides
- **THEN** the save is refused with 403

### Requirement: A read-only step can run on its own thread

An agent step that sets `thread: new` SHALL run on a new thread of the enabler, on the same
runtime as the implementing thread, instead of continuing the implementing thread. Such a step
SHALL resolve to permission mode `plan`; a flow whose `thread: new` step resolves to any other
mode SHALL be refused at load. Later steps without `thread: new` SHALL keep continuing the
implementing thread. The new thread SHALL be recorded with the run, stopped with the run, and
replayed (not started again) when the run resumes.

#### Scenario: A review on another provider
- **WHEN** a flow's `review` step sets `thread: new`, `provider: codex` and `permission_mode: plan`, and the next step continues the implementing thread with `{{review.output}}`
- **THEN** the review runs on its own thread with `codex`, and the follow-up on the implementing thread receives the review's final message

#### Scenario: A writing step on its own thread is refused
- **WHEN** a flow sets `thread: new` on a step whose resolved permission mode is `autoEdit`
- **THEN** the flow is refused with a message naming the step

#### Scenario: A resumed run does not start the review again
- **WHEN** the server restarts while a run's `thread: new` step has a recorded thread
- **THEN** the resumed run waits on that recorded thread and does not start another

### Requirement: Prompts can be loaded from files next to the flow

An agent step SHALL accept `prompt_file` instead of `prompt`, naming a file relative to the
flow's directory. For a repository flow the file SHALL be read from the repository's default
branch, like the flow; for a built-in flow, from the built-in flows' directory. A path that is
absolute, contains `..`, or does not exist SHALL make the flow fail to load with a message
naming the path. A step that sets both `prompt` and `prompt_file`, or neither, SHALL be refused.
The file's text SHALL be templated exactly like an inline prompt.

#### Scenario: A shared implement prompt
- **WHEN** a repository's `issue-to-pr.yaml` and `issue-to-merge.yaml` both set `prompt_file: prompts/implement.md`
- **THEN** both runs send the text of `.funny/workflows/prompts/implement.md` from the default branch, with its variables filled in

#### Scenario: A prompt file on the working branch is ignored
- **WHEN** a run's working branch edits `.funny/workflows/prompts/implement.md`
- **THEN** the run uses the default branch's version

#### Scenario: A path escaping the workflows directory is refused
- **WHEN** a step sets `prompt_file: ../../secrets.txt`
- **THEN** the flow fails to load with a message naming the path, and no thread starts

### Requirement: Runs record and show where their flow came from

A run SHALL record whether its flow came from the repository or was built in, the
default-branch commit the repository flow (and its prompt files) was read at, and the effective
options of each agent step it ran. The run list SHALL show the flow name, its source and commit,
and each agent step's provider, model, effort and permission mode. A resumed or retried run
SHALL keep the source it recorded when it started.

#### Scenario: The run row shows a repository flow
- **WHEN** a run executes `.funny/workflows/issue-to-merge.yaml` read at commit `abc1234`
- **THEN** the run row shows `issue-to-merge`, `repository`, `abc1234`, and the options of each agent step it ran

#### Scenario: A built-in flow is labelled
- **WHEN** a run executes the built-in `issue-to-pr`
- **THEN** the run row shows the source `built-in` and no commit

### Requirement: A factory's flow can be validated before a run

A member SHALL be able to validate a flow of their factory without starting a run. Validation
SHALL load the flow exactly as an admitted run would (default branch, prompt files, factory
checks, the factory's step overrides) and SHALL answer either the load error or a summary:
the flow's source and commit, and for each step its id, kind and, for agent steps, the
resolved options and thread. It SHALL also list step overrides that name no step of the flow.
Validation SHALL NOT start a thread or touch the repository.

#### Scenario: A broken repository flow is reported
- **WHEN** a member validates a factory whose repository flow has a YAML syntax error
- **THEN** validation answers the parse error with its location, and no run or thread is created

#### Scenario: A valid flow is summarized
- **WHEN** a member validates the built-in `issue-to-merge`
- **THEN** validation lists its steps with their kinds, and for each agent step its resolved options and whether it continues the implementing thread

#### Scenario: A stale override is reported
- **WHEN** the factory has an override for step `review` and the validated flow has no step `review`
- **THEN** the summary lists the `review` override as unused

### Requirement: Built-in flows recover a missing pull request

The built-in flows that open a pull request SHALL, when the agent finished without an open pull
request from the run's branch, send the implementing thread one follow-up asking it to push the
branch and open the pull request, and look again. If there is still no pull request, the run
SHALL fail as it does today.

#### Scenario: The agent forgot to open the pull request
- **WHEN** the implement step completes, the branch exists, and there is no open pull request from it
- **THEN** the implementing thread receives a follow-up asking it to open one, and the run continues to CI when it does

#### Scenario: Still no pull request after the follow-up
- **WHEN** the follow-up completes and there is still no open pull request from the branch
- **THEN** the run fails with the "the agent did not open one" reason

### Requirement: The CI fix step receives enough context to reproduce the failure

When `wait_ci` fails on red checks, the failure handed to the fix step SHALL name the commit
that was checked and, for each failing check (up to a bounded number), its name, a link to it,
the failed job step when the CI provider reports one, and a bounded tail of its log. The total
size SHALL stay bounded.

#### Scenario: A failing GitHub Actions job
- **WHEN** a GitHub Actions check fails in its `Run tests` step
- **THEN** the fix step's context names the head commit, the check, the step `Run tests`, a link to the check, and the end of its log

## MODIFIED Requirements

### Requirement: The CI-driven fix loop

When `wait_ci` reports red, the flow SHALL be able to run a fix step (an agent resuming the
run's session) and re-check, up to the flow's configured retry limit, via the flow's
`retry.before_retry`. The fix step SHALL run with its own resolved agent options (see "Agent
steps run with their own options"), on the implementing thread. When the retry limit is
exhausted without green, the run SHALL reach a non-merged terminal or waiting state rather than
merging.

#### Scenario: A red check triggers a fix and re-check
- **WHEN** `wait_ci` reports red and the retry limit is not exhausted
- **THEN** the flow runs its fix step with the failing-check context and re-runs `wait_ci`

#### Scenario: Exhausted retries do not merge
- **WHEN** the fix loop reaches its retry limit without green checks
- **THEN** the run stops before `merge` in a non-merged state that surfaces the failure
