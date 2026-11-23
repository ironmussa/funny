# Proposal

## Why

A factory run has one agent that implements the issue, fixes its own CI and, through the
`merge` step, gets its change merged on green checks alone: nobody independent judges whether
the change does what the issue asked, a CI fix that weakens a test reaches the default branch
unreviewed, and two runs that are green on an old base can merge into a broken default branch.
Other agent factories (GitHub Copilot, Devin, OpenAI's Codex setup, Spotify's Honk, Factory.ai)
converge on separate roles: one agent writes, a different one judges, and the platform merges
by rule on a base that includes everything merged before. With `maxConcurrent > 1` and the
reviewed-flow work in `factory-flow-step-options`, funny needs that shape now.

## What Changes

- **Agent roles.** A factory run uses up to four independent agents with fixed contracts, and
  the server is the only orchestrator between them:
  - **Triage** (new, read-only, short-lived): decides whether an issue can be worked unattended
    and writes the run's **contract**: acceptance criteria, likely paths, risk hints, or the
    questions to ask.
  - **Implementer** (today's agent): the only writer of the run's branch; every fix (CI, review
    findings, integration conflicts) is a follow-up on its thread.
  - **Reviewer** (new, read-only, one thread per head commit): judges one commit of the pull
    request against the contract and answers `pass` / `fail` with findings.
  - **Sentinel** (new, read-only, per factory): when the default branch turns red after a
    factory merge, names the merge that broke it and has the server open a revert pull request
    and pause the factory.
- **Invariants.** Only the implementer writes to the run's branch; no agent merges, approves or
  publishes to GitHub (the server does); a review verdict holds for one commit; agents see each
  other's results only as artifacts the server stored and validated, never each other's threads;
  invalid agent output fails closed for gates.
- **Structured agent results.** Triage, reviewer and sentinel end with a JSON result that the
  server validates against the role's schema; one retry, then the role's failure rule.
- **`needs_info` runs.** An issue triage cannot work holds no slot and gets a templated comment
  with the questions; it is triaged again when the issue changes.
- **Path reservation.** The factory does not admit an issue whose likely paths overlap a run in
  flight; it waits with a reason, like a blocked issue.
- **Deterministic checks before review.** A test-weakening check (deleted or skipped tests,
  lowered thresholds, edited CI workflows) and a risk classification (diff size, sensitive
  paths, test-weakening flags, triage hints) run on the server, not in an agent.
- **BREAKING (flow behaviour):** `merge` no longer merges on green checks alone. It requires a
  `pass` review of the pull request's head commit (unless the flow sets `require_review: false`),
  a low risk class (unless the factory allows all risks), and green checks **on the current
  default branch**, through a per-repository merge lane (GitHub's merge queue when the branch
  requires it; otherwise update-branch, checks, merge, one pull request at a time). A high-risk
  or unreviewed run parks in `waiting_human` with the review on the pull request.
- **Integration conflicts.** A conflict goes to the implementer with the diff of the pull
  request that merged first, plus a specific instruction for known shapes (regenerate the
  lockfile, renumber the migration); agents bring the default branch in with a merge, never a
  rebase or force push, and a force-pushed branch parks the run.
- **The review is visible on GitHub.** The server posts each verdict as a pull request review
  comment and, when the App may, a `funny/review` commit status.
- **The review overlaps CI.** The server starts the review of a head commit when its checks
  start, so a run does not wait for CI before the reviewer looks; a review of a commit that is
  replaced is stopped and discarded. `merge` still needs both results for the same commit.
- **A conflict is an agent's work, a merge is not.** The server decides and performs every
  merge by rule. What needs judgement (a conflict with the base, checks red on the updated
  base) goes to the implementer as a follow-up; what no agent can fix (App permissions, branch
  rules, a rewritten branch) parks the run with the reason.
- The built-in `issue-to-merge` gains `triage` and `review` steps; `issue-to-pr` gains `triage`.
- **Two phases.** Phase 1 ships the reviewer, the deterministic checks and the merge lane: they
  answer the two problems above (nobody independent judges; green on an old base) and work
  without a contract, the reviewer judging against the issue. Phase 2 adds triage and the
  contract, path reservation and the sentinel.

## Capabilities

### New Capabilities

<!-- None: these are the issue factory's behaviour. -->

### Modified Capabilities

- `issue-factory`: agent roles and their isolation rules, structured agent results, triage and
  `needs_info`, path reservation, the review gate bound to a commit, the test-weakening check
  and risk class, the merge lane on the current default branch, integration conflict handling,
  and the post-merge sentinel. The `merge` requirement changes.

## Impact

- **Depends on** `workflow-dag-engine` (loops, concurrency groups, journal) and
  `factory-flow-step-options` (`thread: new` read-only steps, per-step options);
  it ships no reviewed built-in; the gating review is the `review` step here.
- **`packages/workflows`**: `triage` and `review` step kinds, `merge.require_review`, the result
  schemas, the built-in flows and prompt files.
- **`packages/server/src/services/factory/`**: action provider (triage / review steps, result
  validation), watcher (needs-info re-triage, path reservation, merge lane, sentinel trigger),
  new modules for risk classification, the test-weakening check, the merge lane, known-shape
  resolvers and the sentinel; `factory-run-control.ts` for the new states.
- **`@funny/core/github-app`**: update-branch, merge-queue enqueue / status, pull request diff
  and file list, review comments, commit statuses, the default branch's check state, revert.
- **GitHub App**: the manifest asks for `statuses: write` (existing installations must accept
  it; until then the verdict is a review comment only). Sandbox tokens keep `statuses: read`.
- **Database**: `factory_runs` gains the contract, verdicts and risk class, and new states
  (`triaging`, `needs_info`, `reviewing`, `merging`); a sentinel incident table; `factory_settings` gains the auto-merge risk level, sensitive
  paths and stage limits. The merge lane is a concurrency-group lease, not a table of its own.
- **Client**: run row shows the contract, verdicts, risk class and the slot it waits for; settings for
  the auto-merge risk level and sensitive paths; the factory's paused-by-incident state.
- **Docs**: `openwiki/architecture/issue-factory.md`, `GLOSSARY.md` (role names),
  `docs/architecture/state-machines.md` (the run and incident machines).
