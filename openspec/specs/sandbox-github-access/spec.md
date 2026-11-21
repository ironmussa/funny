# sandbox-github-access Specification

## Purpose

Gives a sandbox thread full `git` and `gh` access to its own GitHub repository through short-lived, repository-scoped GitHub App tokens, so that the owner's personal access token never enters a sandbox and a leaked sandbox credential is worth one repository for at most an hour.

## Requirements

### Requirement: An admin connects the deployment's GitHub App from funny

An admin SHALL be able to create and connect a GitHub App for the deployment from funny's settings, for a personal account or an organization, without handling the private key: funny SHALL send the admin to GitHub with a pre-filled App manifest (name, the sandbox permissions, no webhook, a redirect back to funny), and on return SHALL exchange GitHub's one-time code for the App's credentials and store the private key encrypted. The callback SHALL only be accepted for a manifest flow the same admin started on this server. Server variables, when set, SHALL take precedence over the stored App. The private key SHALL never be returned by any API.

#### Scenario: Connecting a new App

- **WHEN** an admin clicks Connect GitHub, chooses an organization, and confirms the pre-filled App on GitHub
- **THEN** funny stores the App (ID, slug, owner, encrypted key), shows it as connected, and links to installing it on selected repositories

#### Scenario: A forged or replayed callback

- **WHEN** the callback arrives without the state of a flow the admin started on this server, or with a state already used or expired
- **THEN** funny refuses it and stores nothing

#### Scenario: Non-admins

- **WHEN** a user who is not an admin opens the GitHub App settings or calls their API
- **THEN** they are refused

#### Scenario: Configured through server variables

- **WHEN** `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` are set
- **THEN** funny uses that App, shows its source as the environment, and does not offer to connect another

#### Scenario: Disconnecting

- **WHEN** an admin disconnects the stored App
- **THEN** its stored credentials are deleted, sandboxes stop receiving GitHub tokens, and funny links to deleting the App on GitHub

### Requirement: The owner's personal access token never reaches a sandbox

The system SHALL NOT deliver the owner's GitHub personal access token or a project-level GitHub token to a sandbox runner by any path (data channel, environment, files, clone URL, git configuration), and SHALL NOT accept a change to the owner's GitHub token from a sandbox runner.

#### Scenario: A sandbox runner asks for the owner's token

- **WHEN** a sandbox runner requests the owner's GitHub token or the `github` provider key
- **THEN** the request is refused and audited, and a normal runner of the same owner still gets it

#### Scenario: The agent inspects its environment

- **WHEN** an agent in a sandbox lists its environment, reads gh's configuration or the checkout's git configuration
- **THEN** no value is the owner's personal access token

### Requirement: Sandbox threads get repository-scoped App tokens

For a sandbox thread whose repository is on GitHub and has an installation of the deployment's GitHub App, the server SHALL mint an installation token restricted to that one repository and to the App's configured permissions, valid for at most one hour. The App's private key SHALL stay on the server.

#### Scenario: Token for the thread's repository

- **WHEN** the sandbox runner of a thread on `acme/app` asks for its GitHub token
- **THEN** it receives a token that GitHub accepts for `acme/app` and refuses for every other repository, with its expiry

#### Scenario: Repository without the App installed

- **WHEN** the thread's repository has no installation of the App
- **THEN** no token is issued, the sandbox has no GitHub credential, and the thread explains that the App must be installed on the repository's account

#### Scenario: Thread not entitled

- **WHEN** a runner asks for a token for a thread that is not its own sandbox thread, or the thread is archived or deleted, or its sandbox is not running
- **THEN** the request is refused and no token is minted

### Requirement: git and gh in the sandbox use the App token and keep working

The sandbox SHALL configure `git` and `gh` to authenticate to GitHub with the thread's App token, and SHALL renew the token before it expires for as long as the sandbox runs, without restarting the agent.

#### Scenario: gh and git work

- **WHEN** the agent runs `gh pr create`, `gh issue list`, `gh api repos/{owner}/{repo}`, `git fetch` or `git push` on the thread's repository
- **THEN** they authenticate with the App token and succeed within the App's permissions

#### Scenario: A long session

- **WHEN** the agent keeps working for more than one hour
- **THEN** the token has been renewed and `git` and `gh` keep authenticating

#### Scenario: The clone

- **WHEN** a sandbox clones a private repository with the App installed
- **THEN** the clone authenticates with the App token, and no token is left in the remote URL or the git configuration
