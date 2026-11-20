# Proposal

## Why

Users want to drive funny from any surface (laptop, phone) against the hosted server while agents run on remote compute, with **one isolated machine per thread** so parallel tasks never share processes, ports, services or dependencies. A git worktree isolates files and branches but not processes. Several providers now offer VMs/sandboxes that stop with their disk preserved and resume on demand, billed per running time (Boat.dev first; E2B, Daytona, Modal, Fly Machines, Railway or a self-hosted Podman/Firecracker host are candidates). funny should own the per-thread lifecycle once and plug providers in behind a stable contract.

This supersedes `provision-railway-runners` (archived 2026-10-31, never implemented), reusing its foundation: provider abstraction, encrypted infra connections, zero-touch enrollment, public server URL detection and headless Claude credentials.

## What Changes

- **Provider-neutral sandbox contract** (`SandboxProvider`): validate credential, describe capabilities, create from template, status, stop, resume, extend lifetime, destroy. Providers declare **capabilities** (stop/resume with disk, max lifetime, sizes, inbound ports, snapshot templates, env limits); funny's lifecycle adapts to them instead of branching on provider names. A **provider registry** lists implemented providers; adding one = new adapter + template recipe + contract tests, no changes to routing, lifecycle, backup or UI.
- **Boat.dev** is the first provider. A fake in-memory provider backs the tests and the contract suite every adapter must pass.
- **Infra connections**: encrypted provider credential (never returned) per user, typed by provider with a provider-defined config schema.
- **Thread-bound enrollment**: single-use, short-lived provisioning token bound to user + project + thread.
- **New runner role `sandbox`**: serves ONLY its thread. Routing for that thread goes ONLY to its sandbox runner — never to the user's general/dedicated runner, never to another sandbox.
- **"Run in sandbox" option** on thread creation (a thread `runtime`, orthogonal to the `local` / `worktree` git mode): provisions the sandbox, clones the repo, creates branch `funny/<threadId>` from the chosen base and starts the agent once the runner is online.
- **Wake on demand / stop when idle**: follow-up, terminal or git on a stopped sandbox resumes it; the server stops it after an idle window when nothing is active and the backup is synced; a provider-side lifetime cap is set when the provider supports one. Providers without stop/resume are destroyed when idle and recovered from the branch.
- **Remote branch backup**: checkpoint commit + push to `origin funny/<threadId>` after each turn with changes (secrets/ignored files excluded); stop is gated on backup.
- **Recovery**: lost or expired sandbox → new sandbox from the thread branch, conversation continues from persisted messages.
- **Cost guardrails**: per-user max running sandboxes, size per thread, state + running time visible.
- Thread delete destroys its sandbox; the remote branch is kept unless the user chooses to delete it.

## Capabilities

### New Capabilities

- `thread-sandbox-provisioning`: provider-neutral sandbox contract and registry, infra connections, thread-bound enrollment, `sandbox` runner role and strict thread routing, lifecycle (provision, wake, idle stop, recovery, destroy) and cost guardrails. Boat is the first provider.
- `thread-remote-backup`: per-thread remote branch, checkpoint commit + push after each turn, backup status, stop gating on backup.

### Modified Capabilities

<!-- None. -->

## Impact

- **Depends on** `enforce-project-runner-isolation` (runner roles, `runner-scope.ts`) and the runner gRPC transport.
- Shared: schema for `infra_connections`, `runner_provision_tokens`, `thread_sandboxes` (SQLite + PG); `RunnerRole` gains `sandbox`; threads gain `runtime: 'sandbox'`; provider-neutral sandbox state type.
- Server: `services/thread-sandboxes/` (contract, registry, lifecycle orchestration, idle stopper) and `services/thread-sandboxes/providers/<provider>/` (Boat adapter over `@boatdev/sdk`, fake provider); `runner-scope.ts` (`canRunnerAccessThread`), `runner-resolver.ts` (sandbox precedence, no fallback), register path, thread creation use case, thread delete.
- Runtime: provisioning-token enrollment, `thread:bootstrap` control command, checkpoint commit/push after turns, activity reporting, provider-neutral pre-stop backup entrypoint (`funny runner pre-stop`) wired per provider.
- Infra: `scripts/sandbox-templates/<provider>/` recipes sharing one provider-neutral install script (runner + git + Bun + agent CLIs + service unit), pinned to the server version.
- Client: Settings > Infrastructure (provider list from the registry), compose "Run in sandbox" + provider/connection + size (from capabilities), sandbox status/backup badges.
- Cost: provider plan + running time per thread (Boat: US$20/mo plan includes US$20 compute).
