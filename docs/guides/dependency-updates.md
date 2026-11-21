# Updating dependencies

Dependabot does not open version-update PRs for the Bun workspace
(`open-pull-requests-limit: 0` in `.github/dependabot.yml`). We update every
package at once, locally, and land the result as one PR. Security updates still
arrive as their own Dependabot PRs. GitHub Actions versions still come as one
grouped weekly PR.

## Steps

1. Branch from an up-to-date `master`, in a worktree if the main checkout holds
   other work.
2. Bump the versions: `bun update --latest`, or edit the `package.json` files.
   Move packages that must match together:
   - the whole `vitest` / `@vitest/*` family (the client's Storybook tests);
   - `@tanstack/db` with `@tanstack/react-db`.
3. `bun install`. In a new worktree, also build or copy the native git module
   (`bun run build:native`).
4. Run every check. Majors usually break the typecheck or the build before the
   tests:

   ```bash
   bun run lint
   bun run typecheck
   bun fmt --check .
   bun run test                              # every package except the client
   bun run --cwd packages/client test        # client unit tests
   bun run build
   bun run --cwd packages/client build-storybook
   ```

5. Fix what broke, in the same branch. Keep formatter-only output from an
   upgrade of Bun (which ships `bun fmt`) in its own commit.
6. Open one PR. CI also runs GPUIX on macOS and Windows, e2e, and the format
   check as CI sees it. Merge once it is green.

## Known constraints

- **`web-tree-sitter` stays at 0.20.8.** The `tree-sitter-wasms` grammars need
  that ABI. Dependabot ignores it.
- **`satteri`:** the client vendors the `@bruits/satteri-wasm32-wasi` browser
  binding in `packages/client/vendor/satteri-wasm32-wasi`, because Bun skips
  `wasm32` packages. Refresh that copy to the same version, as
  `THIRD_PARTY.md` describes.
- **`deepagents-acp`** pins `@agentclientprotocol/sdk` 1.x and keeps its own
  nested copy. Check that it still resolves after an ACP SDK bump.
