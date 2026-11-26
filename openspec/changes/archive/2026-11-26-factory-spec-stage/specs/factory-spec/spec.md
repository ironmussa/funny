# Spec Delta

## Purpose

Lets the team settle an issue's open product decisions with an agent before the factory
implements it, and holds the implementer and the reviewer to the spec the team approved.

## ADDED Requirements

### Requirement: The spec stage is a factory setting

A factory SHALL have a Spec stage setting, off by default, saved by a member with `steer`. While
it is off, triage SHALL NOT be offered the `needs_spec` answer, and a `needs_spec` answer SHALL be
treated as an invalid triage result. Turning it off SHALL NOT end the runs already in
`needs_spec`.

#### Scenario: A new factory

- **WHEN** a member enables a factory without changing its settings
- **THEN** triage can answer `ready`, `needs_info`, `too_big` or `already_done`, and never
  `needs_spec`

#### Scenario: Turned off while a spec is open

- **WHEN** a run is `needs_spec` and a member turns the Spec stage off
- **THEN** the run stays in `needs_spec` and can still be answered and approved

### Requirement: A spec writer holds the conversation

When triage answers `needs_spec`, the system SHALL park the run in `needs_spec`, holding no
concurrency slot, and SHALL start a spec writer: a read-only agent on a new thread of the
enabler, given the issue's text and triage's open decisions as inputs, never inlined in its
prompt. The spec writer SHALL NOT write to the repository or the issue, and SHALL NOT be given
another agent's thread. Nothing SHALL be posted on the issue. The enabler SHALL be notified that
the run waits on the spec.

#### Scenario: Open product decisions

- **WHEN** triage answers `needs_spec` with three open decisions
- **THEN** the run is `needs_spec`, the factory's free slots do not count it, a spec writer
  thread exists for the run, and the issue gets no comment

#### Scenario: The spec writer cannot write

- **WHEN** a spec writer tries to edit a file in its checkout
- **THEN** the edit is denied

### Requirement: Every spec writer turn ends with a validated result

Each turn of the spec writer SHALL end with a structured result that the system validates: either
questions (at least one, each with optional proposed answers) or a spec draft. A draft SHALL hold
a summary, the decisions taken with the answer each one got, the product behavior, the technical
approach, what is out of scope, a validation checklist of at least one item, and the run's
contract (acceptance criteria, likely paths, risk hints). An invalid result SHALL get one request
on the same thread to emit it again; a result still invalid SHALL leave the run in `needs_spec`
with the reason shown, and a member can follow up on the thread or retry the spec. The system
SHALL store the latest valid result on the run and notify the enabler of each new one.

#### Scenario: The writer asks

- **WHEN** a spec writer turn ends with two questions
- **THEN** the run shows two open questions and the enabler is notified

#### Scenario: A member answers

- **WHEN** a member answers the questions as a follow-up on the spec writer's thread and its next
  turn ends with a draft
- **THEN** the run stores the draft, replacing the questions, and shows it as waiting for approval

#### Scenario: An invalid draft twice

- **WHEN** a draft without a validation checklist is emitted, asked again, and emitted again
  without one
- **THEN** the run stays in `needs_spec` and shows that the spec writer gave no valid spec

### Requirement: Only a member approves a spec

A member with `steer` on the factory's project SHALL be able to approve the stored draft from
their browser session, naming the draft they saw. The system SHALL refuse the approval when the
stored draft has changed since, when the run is not `needs_spec`, or when the draft is not the
latest result. On approval the system SHALL store the spec with who approved it and when, store
the draft's contract as the run's triage contract, and send the run back to the queue at its
earlier position, by compare-and-set from `needs_spec`. No agent SHALL approve a spec; an agent
MAY ask a member to approve one, which shows the draft on a card the member answers.

#### Scenario: Approving the draft shown

- **WHEN** a member approves the draft the run shows
- **THEN** the run is back in the queue ahead of runs sent after it, and its stored triage is
  `ready` with the draft's contract

#### Scenario: The draft changed meanwhile

- **WHEN** a member approves a draft and the spec writer stored a newer one before the approval
  arrived
- **THEN** the approval is refused and the member sees the newer draft

#### Scenario: An agent cannot approve

- **WHEN** an agent asks to approve a spec through the factory tools
- **THEN** no spec is approved, and a card asking the member to approve it appears

### Requirement: An approved spec binds the implementer

The implementer's first prompt for a run with an approved spec SHALL contain the spec. The
prompt SHALL tell the implementer that the spec's decisions are not its to change, and that a
choice the spec leaves open is decided and stated in the pull request. When the factory's Commit
spec setting names a path, the implementer SHALL be told to commit the spec there, with the
issue number in the name. An approved spec SHALL NOT be discarded when the issue changes; a
member can reopen it.

#### Scenario: Implementing from a spec

- **WHEN** a run with an approved spec is admitted
- **THEN** triage does not run again and the implementer's first prompt contains the spec's
  decisions and validation checklist

#### Scenario: The issue is edited after approval

- **WHEN** the issue of a run with an approved spec is edited before the run is admitted
- **THEN** the run keeps its spec and is not triaged again

### Requirement: A member can reopen a spec

A member with `steer` SHALL be able to reopen the spec of a run that is `needs_spec`, or of a run
with an approved spec that has not started implementing or has parked. Reopening SHALL keep the
earlier conversation's thread, drop the approval, and put the run in `needs_spec` with the spec
writer asked to revise it.

#### Scenario: Revising after a failed run

- **WHEN** a member reopens the approved spec of a `waiting_human` run
- **THEN** the run is `needs_spec`, its spec is no longer approved, and the spec writer's thread
  gets a follow-up asking for a revision

### Requirement: The spec is visible to members and agents

The run's detail panel SHALL show the stored spec result: its open questions with a link to the
spec writer's thread, or its draft with an Approve action for members with `steer`, or the
approved spec with who approved it. The factory tool that reads one run in detail SHALL return
the spec and its approval state.

#### Scenario: Reading a run with an approved spec

- **WHEN** an agent reads a run with an approved spec through the factory tools
- **THEN** the result contains the spec's decisions and who approved it
