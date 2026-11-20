# Spec Delta

## Purpose

Ensures every request that targets a project is authorized by one shared, consistent access rule before it touches project data, the project's repository, or the user's GitHub credentials.

## ADDED Requirements

### Requirement: Project-scoped routes authorize before handling

Every route that resolves a project by id — on the server and on the runner, including GitHub pull-request, issue, review-thread, and PR-file routes — MUST authorize the requesting user against that project before its handler reads project data, runs git or GitHub operations, or resolves a GitHub token. The decision MUST come from a single shared project-access rule, not from per-handler inline checks.

#### Scenario: Owner accesses their project

- **WHEN** the project owner requests a project-scoped route
- **THEN** the request is handled normally

#### Scenario: Unrelated user requests another user's project

- **WHEN** a user who is neither owner, member, nor in the project's organization requests a GitHub route for that project
- **THEN** the response is `404 Project not found` and no git command, GitHub API call, or token lookup is performed

### Requirement: Consistent access levels

The shared rule MUST expose explicit access levels (at least read and admin) and MUST apply the same membership semantics everywhere: read access is granted to the owner, project members, and members of the project's organization; admin access is granted to the owner and project admins. Routes MUST declare which level they require.

#### Scenario: Organization member reads project settings

- **WHEN** a member of the project's organization requests a read-level route (e.g. project settings or designs)
- **THEN** access is granted on every such route, not only some of them

#### Scenario: Member attempts an admin-level action

- **WHEN** a non-admin project member calls an admin-level route
- **THEN** the request is rejected with the same not-found response as an inaccessible project

### Requirement: Non-revealing failure

An authorization failure on an existing project MUST return the same response as a request for a project that does not exist, so responses do not reveal which project ids exist.

#### Scenario: Probing a project id

- **WHEN** a user requests a route for an existing project they cannot access and, separately, for a random non-existent id
- **THEN** both responses have the same status code and body
