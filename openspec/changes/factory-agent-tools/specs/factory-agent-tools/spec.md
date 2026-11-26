# Spec Delta

## Purpose

Lets an agent in a thread read the thread owner's issue factory runs, retry, stop or mark one as
done, close the pull request of a replaced run, and ask
the member to approve merging a held high-risk change, without ever being able to approve it.

## ADDED Requirements

### Requirement: An agent lists the thread owner's factory runs

An agent in a project thread SHALL be able to list the runs of the thread owner's factory in the
thread's project. Each run SHALL show its issue number, its pull request, its state,
why it waits when it waits, its risk class, whether its held commit is approved, and its open
merge approval request when it has one. The list SHALL contain no run of another member's
factory, no run of another project, and no text written outside funny (issue titles, review text).

#### Scenario: Runs of the thread's project

- **WHEN** an agent in a thread of project P, owned by member M, lists the factory runs
- **THEN** it receives M's runs in P, each with its state and the reason it waits

#### Scenario: Another member's factory

- **WHEN** member N also runs a factory in project P and an agent in M's thread lists the runs
- **THEN** none of N's runs is returned

#### Scenario: No factory

- **WHEN** the thread owner has no factory in the thread's project
- **THEN** the tool answers that there is no factory, and returns no run

### Requirement: An agent retries or stops a run as the thread owner

An agent SHALL be able to retry or stop one run of the thread owner's factory in the thread's
project, mark one that ended with no change or was stopped as done, and close the pull request
of a run a newer run of its issue replaced. Each is a named control of the board; the agent
SHALL NOT be able to name a state for a run, a split or a merge approval. The action SHALL be decided, executed, audited and shown in the owner's activities
exactly as the same action from the board, with the thread that asked recorded on it. It SHALL
require the thread owner's `steer` on the project at the time of the call. The actor SHALL be
the thread's owner as the server stores it, never an identity the agent supplies.

#### Scenario: Retrying a failed run

- **WHEN** an agent retries a run that failed, in a thread whose owner has `steer`
- **THEN** the run goes back in flight as it does from the board, and the owner's activities
  show the retry and the thread that asked

#### Scenario: Marking a stopped run as done

- **WHEN** an agent marks as done a run that was stopped, in a thread whose owner has `steer`
- **THEN** the run becomes `done` as it does from the board, and the owner's activities show it
  and the thread that asked

#### Scenario: Naming a state

- **WHEN** a runner sends a control that is not one of the named controls (`done`, `merged`,
  `split`, `approve-merge`)
- **THEN** the server refuses it and the run does not change

#### Scenario: A run that cannot be retried

- **WHEN** an agent retries a run that is working
- **THEN** the tool reports the same refusal as the board and the run does not change

#### Scenario: The owner lost access

- **WHEN** the thread owner no longer has `steer` on the project and the agent stops a run
- **THEN** the action is refused and the run does not change

#### Scenario: A run of another project

- **WHEN** an agent names a run that belongs to another project or another member's factory
- **THEN** the tool answers that the run was not found

### Requirement: An agent can ask for a merge approval and cannot give one

An agent SHALL be able to ask the member to approve merging a run that is held as high risk.
The request SHALL be bound to the run and to the commit held at that moment. The agent SHALL
supply only the run: every fact the member is shown SHALL come from the server. No message from
an agent, an MCP server or a runner SHALL approve a merge, approve a request, or change what a
request shows.

#### Scenario: Asking for a held run

- **WHEN** an agent asks for the approval of a run held as high risk on commit A
- **THEN** a pending request for that run and commit A exists, and the tool returns at once
  saying the member has been asked

#### Scenario: A run that is not held

- **WHEN** an agent asks for the approval of a run that is working, merged, or parked for
  another reason
- **THEN** no request is created and the tool says the run is not waiting for an approval

#### Scenario: Asking twice

- **WHEN** an agent asks again for a run that already has a pending request for the same commit
- **THEN** the existing request is returned and no second card appears

#### Scenario: A runner claims an approval

- **WHEN** a runner sends any data-channel message for a run held as high risk
- **THEN** the run's approval is unchanged, whatever the message contains

### Requirement: The member answers a request with their own session

A pending request SHALL appear as a card in the thread that asked and on the run's card on the
factory board. The card SHALL show the issue, the pull request with a link, the held commit, the
size of the change and the risk reasons, and SHALL say that an agent asked. Approving from the
card SHALL be the same operation as approving from the board: it is made with the member's
session, needs `steer`, and names the commit the card shows. Declining SHALL close the request
and leave the run held.

#### Scenario: Approving from the card

- **WHEN** the member approves a pending request for commit A while the run is still held on A
- **THEN** the run's merge approval is recorded for A in the member's name, the run is retried,
  and the request is closed as approved

#### Scenario: Declining

- **WHEN** the member declines a pending request
- **THEN** the request is closed as declined and the run stays held with no approval

#### Scenario: The answer stays in the thread

- **WHEN** the member approves a request and the run then waits for another run that changes the
  same files
- **THEN** the card stays in the thread, says the request was approved, and shows the run's state
  and why it waits

#### Scenario: Another member answers

- **WHEN** a member who is not the factory's owner opens the thread
- **THEN** the card offers them no approval, and an approval they send is refused

### Requirement: A request does not outlive the commit it shows

A pending request SHALL close as expired when the run's held commit is no longer the one the
request shows, or when the run stops waiting for an approval for any reason other than the
request being approved. An expired or declined request SHALL approve nothing. A merge approval
moves to a newer commit only by the rules of `issue-factory`, after a member approved.

#### Scenario: The pull request changes while the member decides

- **WHEN** a request shows commit A and the run is then held on commit B
- **THEN** the request for A is expired and its card no longer offers an approval

#### Scenario: Approved from the board meanwhile

- **WHEN** the member approves the run from the board while a request is pending
- **THEN** the request is closed as approved

#### Scenario: The agent reads the outcome

- **WHEN** an agent lists the runs after its request was approved, declined or expired
- **THEN** the run shows that outcome

### Requirement: The tools are refused where the agent's input is not the owner's

The three tools SHALL be refused in a sandbox thread, a read-only thread, a scratch thread and
a thread the factory itself started. The refusal is the server's: it does not depend on what the
runner lists or sends. Retrying, stopping and asking for an approval SHALL also be
refused in a thread that is shared at `steer`. A refusal SHALL change nothing and SHALL tell the
agent why.

#### Scenario: A factory thread

- **WHEN** the implementer thread of a run calls any of the three tools
- **THEN** the call is refused

#### Scenario: A sandbox runner

- **WHEN** a sandbox runner sends one of the factory data-channel messages
- **THEN** the server refuses it

#### Scenario: A thread shared at steer

- **WHEN** an agent in a thread that has a `steer` share retries a run
- **THEN** the retry is refused, and listing the runs still works
