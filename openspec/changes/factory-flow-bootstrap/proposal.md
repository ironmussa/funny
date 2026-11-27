# Proposal

## Why

A factory can be enabled on a repository whose flow can never merge. The built-in flows declare
`regression_proof` without rules, so a repository with no `.funny/workflows/<flow>.yaml` keeps every
issue `requested` with the blocker "regression proof not configured", and nothing at enable time
says so. Issues #2145 and #2146 of `goliiive-v2-new` (Nx + pnpm, `*.spec.ts`) waited there. Writing
the rules by hand needs the stack, the test runner per package and the specs that need
infrastructure: what funny can work out from the checkout.

## What Changes

- **Enabling needs a ready flow.** The server refuses to turn a factory on when its configured flow,
  loaded as an admitted run would load it, is invalid or not proof-ready (no proof rule and no
  explicit `require_regression_proof: false`), and says why. When GitHub cannot be read it says the
  flow could not be checked, not that it is missing. A factory already enabled is not disabled: it
  keeps today's blocker.
- **"Generate configuration".** When the flow has no proof rules, the factory settings offer to
  generate them. That starts a setup thread on the member's runner, in its own worktree:
  - a **deterministic** detector reads the checkout (lockfile, monorepo, test runner per package)
    and hands its findings to the agent;
  - the agent writes `.funny/workflows/<flow>.yaml`, starting from the repository's own flow file
    when it has one, else from the built-in flow, and changing only `regression_proof`;
  - funny, not the agent, **verifies each rule by running it in a clean checkout**: a passing
    canary passes, a canary failing by an assertion fails by an assertion, and an existing test of
    the repository that the rule matches loads and passes. A rule that does not do all three is
    dropped;
  - the result is a proposal (the file, the detected stack, each rule's verification, what stays
    uncovered). Nothing is committed until the member confirms it. Then funny commits only that
    file and pushes it to the repository's default branch, without force.
  - **When the branch refuses the push** (required checks, required reviews), funny offers to open
    a pull request with that commit instead. The factory stays off until the file is on the default
    branch.
- **Changing the factory's configuration is always high risk.** `.funny/**` and `.funny.json` become
  default sensitive paths, so a run's pull request that edits the flow, its prompts, the proof rules
  or `.funny.json` commands cannot merge without a member's approval. Today a low-risk run can
  auto-merge an edit of its own merge policy.

Not in this change: reading the flow from the factory's "Merge into" branch. The flow is still read
from the repository's default branch on GitHub, never from a runner's checkout (design D2).

## Capabilities

### New Capabilities

- `factory-flow-bootstrap`: generating, verifying and committing a factory's flow file from the
  repository's stack, from the factory settings, before the factory is enabled.

### Modified Capabilities

- `issue-factory`: enabling needs a flow that loads and is proof-ready; the factory's own
  configuration is a default sensitive path.

## Impact

- **Server:** `factory/factory-settings.ts` (enable gate on save), `factory/factory-queue-flows.ts`
  (`validateFlow` is the readiness check), `factory/factory-risk.ts` (default sensitive paths), a new
  setup service (thread, detection, verification job, proposal, confirm through the certified runner
  sink, pull request fallback), `trpc/ports/factory.ts`.
- **Runtime:** the stack detector; rule verification in a temporary clean worktree, reusing
  `fillCommand`, `matchesGlob`, `inconclusiveBaseFailure` and the proof job pattern of
  `services/regression-proof.ts`; commit + push of one file with the owner's credentials.
- **Workflows:** `isProofReady` and the flow schema are unchanged; a generated flow is validated by
  the same parser.
- **API:** `@funny/api` `factory` group gains `startFlowSetup`, `flowSetup`, `confirmFlowSetup`,
  `openFlowSetupPullRequest`, `discardFlowSetup`; `saveSettings` fails with `flow-not-ready`.
- **Client:** factory settings (enable switch disabled with its reason, "Generate configuration",
  the proposal card), `data/factory/`.
- **Docs:** `openwiki/architecture/issue-factory.md`, CLAUDE.md factory section,
  `docs/architecture/state-machines.md`.
- **Existing factories:** none changes state. Runs that edit `.funny/**` become high risk.
