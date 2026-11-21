# Tasks

## 1. Data model

- [x] 1.1 Add `runners.role`, `user_profiles.general_runner_id`, `projects.runner_id` and `project_credentials` to shared schema (SQLite + PG) and migrations with general-runner backfill; verify with migration tests on both dialects
- [x] 1.2 Extend repositories for role, general runner and project override; verify with repository unit tests

## 2. RunnerScope service

- [x] 2.1 Implement `RunnerScope` (`canAccessProject`, `scopedProjectIds`, invalidation) with cache; verify unit tests for general/dedicated/grant/revoked cases
- [x] 2.2 Document the predicate rule ("never check runner scope ad hoc") in CLAUDE.md Runner Isolation section; verify doc updated

## 3. Routing

- [x] 3.1 Rewrite `runner-resolver.ts`: project override → primary ∪ grants; else general; remove strategy 4; return typed "project runner offline" / "no general runner"; verify resolver tests incl. offline-no-fallback scenarios
- [x] 3.2 Classify projectless routes (browse, scratch, user GitHub, settings) to the general runner only; verify proxy tests
- [x] 3.3 Restrict `resolveAnyRunner` to the user's general runner from OAuth state; verify test that a dedicated runner is never selected

## 4. Data channel

- [x] 4.1 Add project resolution + `RunnerScope` check to `assertDataOwnership` for every `data:*` type, with `runner.scope_denied` audit; verify table-driven test that fails if a data type lacks a resolver
- [x] 4.2 Filter listing operations to scoped projects; verify listing tests
- [x] 4.3 Limit event relay and settings/credential pushes to scoped projects while still delivering user-level settings; verify tests

## 5. Credentials

- [x] 5.1 Project git credential override with fallback to user PAT, delivered per operation; verify push/PR tests use the right token
- [x] 5.2 Client: Project Settings "Git credentials" section + personal-token warning for dedicated runners (shadcn, data-testid, i18n en/es/pt); verify component tests

## 6. Settings UI & revocation

- [x] 6.1 Client: user Settings "General runner" selector; Project Settings "Runner" section (use general / dedicated + grants); verify component tests
- [x] 6.2 Revocation: invalidate scope, send `project:revoke`, runtime stops sessions of that project; verify runtime + server tests
- [x] 6.3 Client offline state: "project runner offline" banner on thread/project views; verify component test

## 7. Integration

- [x] 7.1 Vertical isolation test: two runners of the same user, dedicated to X and Y; assert no routing, data or event crossing, and offline X does not fall back to Y; verify passes in CI
