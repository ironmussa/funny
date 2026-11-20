# Tasks

## 1. Pull request action

- [ ] 1.1 Add a `draft` option to `createPR` in `packages/core/src/git/remote.ts` and thread it through the runtime's `git-service` `createPR`; verify with a unit test that asserts `--draft` and `--base` appear in the `gh` arguments only when set
- [ ] 1.2 Add `base` and `draft` to `CreatePrOpts` and pass them in `RuntimeActionProvider.createPr`, defaulting `base` to the thread's base branch; verify with an adapter test for the explicit and the default case
- [ ] 1.3 Make the YAML compiler pass `create_pr.base` / `create_pr.draft` and document them in the `@funny/workflows` schema; verify with a compiler test
- [ ] 1.4 Verify `create_pr` exposes the pull request URL as its node output with a workflow test that interpolates it into a later `notify` node

## 2. Agent steps and dispatch

- [ ] 2.1 Make `RuntimeActionProvider.spawnAgent` run its child thread in the parent's worktree and branch, and fail when that worktree is missing; verify with a test that fails on the current code (worktree parent → child cwd is the worktree; local parent unchanged; missing worktree → error)
- [ ] 2.2 Make the runner's `POST /api/scheduler/dispatch` set up the worktree of a worktree thread that has no `worktreePath` and answer an error instead of using the project path; verify with route tests for an idle worktree thread and a setup failure

## 3. Verification

- [ ] 3.1 Run `bun run lint` and `bun run typecheck`, and the tests of `packages/core`, `packages/workflows` and `packages/runtime` that cover these files
