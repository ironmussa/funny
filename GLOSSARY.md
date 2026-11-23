# funny

funny orchestrates coding agents that work in parallel on a user's projects, each in
its own thread.

## Issue factory

**Issue factory**:
The product that turns an issue ready for an agent into a merged or reviewable pull
request without a person in the loop. Each user runs their own.
_Avoid_: Orchestrator, software factory pipeline

**Factory run**:
One attempt by the issue factory to take one issue to a pull request.
_Avoid_: Run (alone), session, job

**Triage**:
The first step of a factory run: a read-only agent decides whether the issue can be worked
unattended, and either writes the run's contract or asks on the issue.
_Avoid_: Refinement, grooming

**Contract**:
What a factory run must do, written by triage before any work: acceptance criteria, the
files it will probably touch and its risks. The implementer works to it and the reviewer
judges against it.
_Avoid_: Spec, plan, ticket

**Sentinel**:
The read-only agent that, when a base branch turns red after a factory merge, names the
merge that broke it or says it cannot.
_Avoid_: Watchdog, monitor

**Incident**:
A base branch that turned red after a factory merge. While it is open, no factory on that
repository admits issues.
_Avoid_: Outage, alert

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
