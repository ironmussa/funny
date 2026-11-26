# Spec Delta

## MODIFIED Requirements

### Requirement: Stage columns

The board SHALL show these columns, in this order, and place each run in exactly one of them by its state:

| Column          | Run states                                                         |
| --------------- | ------------------------------------------------------------------ |
| Queue           | `requested`, `queued`                                              |
| Triage          | `triaging`                                                         |
| Implementing    | `working`, `fixing`                                                |
| PR · Proof · CI | `pr_open`, `waiting_ci`                                            |
| Review          | `reviewing`                                                        |
| Merge           | `merging`                                                          |
| Needs a person  | `needs_info`, `needs_spec`, `waiting_human`, `failed`, `no_change` |
| Done            | `merged`, `stopped`                                                |

A `stopped` run that carries a failure reason (it was stopped after failing, or its pull request was closed without a merge) SHALL be shown in Needs a person, not in Done: nothing has fixed it. A `failed`, `stopped` or `no_change` run whose issue has a newer run in the same factory SHALL be shown in Done: the newer run carries the issue. A run state added later and not in the table SHALL be shown in Needs a person, never dropped. Each column header SHALL show the number of runs in it. Within a column, runs SHALL be ordered by queue position in Queue and by most recent activity (completed, admitted or sent time) elsewhere.

#### Scenario: A run in review

- **WHEN** a run's state is `reviewing`
- **THEN** its card is in the Review column and in no other column

#### Scenario: A run stopped after a failure

- **WHEN** a run's regression proof fails and a member stops the run
- **THEN** its card is in the Needs a person column, not in Done
- **AND** once the issue is sent again, the stopped run's card moves to Done

#### Scenario: An unknown state

- **WHEN** a run carries a state the client does not know
- **THEN** its card is in the Needs a person column

#### Scenario: A run waiting on its spec

- **WHEN** a run's state is `needs_spec`
- **THEN** its card is in the Needs a person column

### Requirement: Why a run is waiting

A run card in Queue or Needs a person SHALL show one line saying, in plain language, why the run is not moving: the queue wait reason (including the blocking issue numbers), the triage questions count for `needs_info`, the spec writer's open questions count or that a spec draft waits for approval for `needs_spec`, the failure reason for `failed`, that nothing needed changing for `no_change`. For `waiting_human` it SHALL give the reason the run recorded when it parked (no review for the commit, review failed, high risk, branch rewritten, unsaved work), and SHALL say the run waits for a person when none was recorded.

#### Scenario: Waiting on overlapping paths

- **WHEN** a requested run waits because its likely paths overlap those of the run for issue 47
- **THEN** its card says it waits on paths shared with #47

#### Scenario: Triage asked questions

- **WHEN** a run is `needs_info` and triage asked two questions on the issue
- **THEN** its card says triage asked 2 questions on the issue

#### Scenario: Held for high risk

- **WHEN** a run is `waiting_human` and recorded that it parked because the change is high risk
- **THEN** its card says it was not merged because it is high risk and needs a person

#### Scenario: A spec waits for approval

- **WHEN** a run is `needs_spec` and its spec writer stored a draft
- **THEN** its card says a spec waits for approval and offers Approve to a member with `steer`

#### Scenario: The spec writer asked questions

- **WHEN** a run is `needs_spec` and its spec writer's latest result asks three questions
- **THEN** its card says the spec has 3 open questions and links to the spec writer's thread
