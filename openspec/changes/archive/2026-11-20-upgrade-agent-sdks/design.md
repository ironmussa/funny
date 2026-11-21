## Context

The Claude dependency is declared through compatible semver ranges but the lockfile resolves `0.3.241`; the Codex dependency is pinned to `0.144.0` in multiple packages. The reviewed current releases are Claude `0.3.251` and Codex `0.151.0`. Their public type deltas are additive, while bundled runtime behavior still requires regression checks. See `proposal.md` for motivation and `specs/agent-sdk-compatibility/spec.md` for the behavioral contract.

## Goals / Non-Goals

**Goals:**

- Keep all workspace declarations of each SDK on one resolved version.
- Preserve the provider-neutral adapter contract.
- Use Codex's newly supported native `max` effort.
- Verify the dependency and adapter changes with focused tests and repository gates.

**Non-Goals:**

- Expose Codex `ultra` or `persistent` effort levels.
- Wire new Claude background-task, queue, hook, or usage events.
- Add MCP timeouts or other roadmap features in the same dependency change.

## Decisions

1. Upgrade Claude and Codex in one scoped OpenSpec change but keep their code adaptations independent. This makes the compatibility work auditable while retaining clear failure attribution in tests. The alternative—upgrading all AI-related packages—would enlarge the regression surface unnecessarily.
2. Keep Funny's shared effort type unchanged and only alter Codex normalization from `max -> xhigh` to `max -> max`. The alternative of adding `ultra` and `persistent` now would expose settings whose model support and product semantics have not been established.
3. Test effort translation through the adapter's SDK boundary or an extracted pure normalizer, depending on the existing test conventions. Avoid assertions against SDK internals beyond the option passed to the public constructor/thread API.
4. Regenerate `bun.lock` through Bun after aligning package manifests. Manual lockfile editing is excluded.

## Risks / Trade-offs

- [Bundled provider runtime behavior changes despite additive types] → Run focused provider tests plus lint and typecheck, and keep unrelated new SDK features unwired.
- [Multiple manifest declarations drift] → Update every existing declaration and verify the lockfile resolves a single intended version.
- [Native `max` is rejected by an unsupported model] → Preserve provider error propagation; model capability filtering remains a separate product enhancement.

## Migration Plan

1. Align package manifests and regenerate the lockfile.
2. Update Codex effort normalization and its regression coverage.
3. Run focused tests, then repository lint and typecheck.
4. Roll back the manifest, lockfile, and one-line normalization change together if provider smoke tests reveal runtime regressions.
