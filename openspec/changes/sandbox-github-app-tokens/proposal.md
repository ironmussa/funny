# Proposal

## Why

A sandbox thread needs GitHub to clone, push and run `gh` (PRs, issues, reviews, Actions, `gh api`, and the scripts agents build from them). Today the sandbox runner gets that access by asking the server for the owner's personal access token (`data:get_github_token`), and PR #153 went further and put it in the agent's environment. Anything inside a sandbox can be read by the agent, and through it by a steer sharee or by a prompt injection. A PAT reaches every repository the owner can reach, often with admin rights, for months, from any machine. A leak from one thread is a leak of the whole account.

The agent has to hold a token it can use, so the token itself has to be worth little. GitHub App installation tokens are exactly that: scoped by GitHub to one repository and a fixed set of permissions, valid for one hour. `git` and `gh` work with them unchanged, so nothing an agent does with GitHub is limited by a proxy of ours.

## What Changes

- Each funny deployment owns its **own GitHub App**; its private key stays on that server and is never sent to a runner. A key cannot be shared between deployments, because whoever holds it can mint tokens for every repository the App is installed on.
- **Connect GitHub (App manifest flow):** an admin clicks _Connect GitHub_ in Settings, picks the account or organization, confirms a pre-filled _Create GitHub App_ page on GitHub, and is sent back; the server exchanges the one-time code for the App ID and private key and stores the key encrypted with the existing keyring. The admin then installs the App on selected repositories. No key is copied by hand. Admins can instead set `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY`, which take precedence. This deployment's App, `funny-sandboxes-ironmussa` (App ID 5690396, installed on `ironmussa`), was created by hand and is configured through those variables.
- For each sandbox thread the server mints an **installation token restricted to the thread's repository** and to the App's permissions (contents, pull requests, issues and workflows read/write; Actions, checks and commit statuses read), valid for one hour.
- The sandbox runner fetches it over its authenticated data channel, **only for its own thread**, and keeps it fresh: `gh` and `git` in the sandbox are configured to use it (gh's config and `gh auth git-credential`), and the runner refreshes it before it expires. The checkout clone uses it too.
- **The owner's PAT never reaches a sandbox** (already enforced: the data channel refuses GitHub secrets to sandbox runners). When the thread's repository has no App installation, the sandbox gets no GitHub credential and the thread shows why.
- **Retired:** the git smart-HTTP broker, the thread capability table and the server-side PR tool of the earlier `sandbox-git-credential-broker` change. A repository-scoped, short-lived token makes them unnecessary, and they would have limited `gh`. The owner-approval gate for pushes by a steer sharee is dropped with them: a token inside the sandbox cannot be gated by the server. Protecting important branches is left to GitHub rulesets.
- Out of scope: user-to-server App tokens (actions shown as the user rather than the App bot), non-GitHub hosts, normal runners (they keep the user's own git and `gh` login).

## Capabilities

### New Capabilities

- `sandbox-github-access`: How a deployment connects its GitHub App (manifest flow or server variables) and how a sandbox thread gets GitHub access: App installation tokens scoped to the thread's repository, delivered only to the thread's own sandbox runner, kept fresh, used by `git` and `gh`; and the guarantee that the owner's PAT never reaches a sandbox.

### Modified Capabilities

<!-- None. -->

## Impact

- **Server:** App configuration (manifest-flow routes and callback, encrypted storage in `instance_settings`, or `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY`); a service that signs the App JWT (RS256 with `node:crypto`), finds the installation for a repository and mints repository-scoped installation tokens, with caching; a data op for the sandbox runner; removal of the broker route, the capability table and migration, and their tests.
- **Runtime:** the sandbox checkout clones with the App token; gh's config and git's credential helper are set to use it, and a refresh loop renews it; no `GH_TOKEN` from the owner.
- **Protocol:** the `GetGitCapability` op becomes `GetGithubAppToken`.
- **Client:** a GitHub App section in Settings (admin): connect, status, install link, disconnect.
- **Operations:** the App's private key is a server secret (encrypted in the DB, or a Railway variable); each organization or account whose repositories sandboxes use must install the App.
- Supersedes the `sandbox-git-credential-broker` change and PR #153.
