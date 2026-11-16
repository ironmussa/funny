# funny

funny orchestrates coding agents that work in parallel on a user's projects, each in
its own thread.

## Issue factory

**Issue factory**:
The product that turns an issue ready for an agent into a merged or reviewable pull
request without a person in the loop. Each user runs their own.
_Avoid_: Orchestrator (for the product), software factory pipeline

**Orchestrator**:
The separate process that runs one user's issue factory: it decides which issues to
admit and when each factory run starts and ends. It starts on its own, apart from the
funny server.
_Avoid_: Agent, factory service

**Factory run**:
One attempt by the issue factory to take one issue to a pull request.
_Avoid_: Run (alone), session, job

**Factory settings**:
One user's configuration of their issue factory: the projects it watches and how it
works on them.
_Avoid_: Factory policy, project factory

**Factory App**:
The GitHub App through which an issue factory reads and changes its repositories; it
is installed only on the repositories the factory watches.
_Avoid_: Bot token, PAT
