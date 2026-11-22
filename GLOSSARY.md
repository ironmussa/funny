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

**Implementer**:
The agent of a factory run that writes the change: it implements the issue, opens the pull
request and fixes what the gates send back. The only writer of the run's branch.
_Avoid_: Coder, worker

**Reviewer**:
The agent of a factory run that judges one commit of its pull request and answers pass or
fail with findings. It runs on its own read-only thread and never sees the implementer's
conversation.
_Avoid_: Review bot (an external app such as CodeRabbit is not the reviewer), approver

**Review verdict**:
The reviewer's validated answer for one commit. It holds for that commit only, and the
factory merges a commit only with a verdict that allows it.
_Avoid_: Approval (the verdict never approves the pull request on GitHub)

**Merge lane**:
The rule that the issue factory merges one pull request at a time per repository and base
branch, on a commit that has the current base.
_Avoid_: Merge agent (no agent merges), merge queue (that is GitHub's own feature)

**Factory settings**:
One user's configuration of their issue factory: the projects it watches and how it
works on them.
_Avoid_: Factory policy, project factory

**Factory App**:
The GitHub App through which an issue factory reads and changes its repositories; it
is installed only on the repositories the factory watches.
_Avoid_: Bot token, PAT
