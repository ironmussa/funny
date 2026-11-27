# Proposal

## Why

A batch of issues opened by an error tracker (twelve PostHog issues on 2026-11-27) cannot go
through the factory without a person sorting it first, for two reasons.

- Triage has no answer for a report that no change to the repository would fix: a request a
  user's network dropped, a 504 from a service the repository does not configure. It can only
  answer `ready` (and invent a fix) or `needs_info` (and wait for an answer nobody will give).
- Two issues for the same defect both run. The second waits for the first because their likely
  paths overlap, then starts with the contract triage wrote before the first one merged, and is
  implemented again.

## What Changes

- Triage may answer `not_actionable` with its evidence. The factory posts the evidence on the
  issue, closes it as not planned and ends the run `done`. When it cannot close the issue, the
  run parks in `needs_info` with the evidence posted, as for `already_done`.
- A run that left its slot to wait for runs working on the same files is triaged again when it
  comes back, if a run that changed those files merged into its base branch meanwhile. The
  second triage reads the merged code, so a duplicate is answered `already_done` and closed. A
  contract that came from an approved spec is kept.

Triage still reads one issue at a time: no issue's text reaches another issue's triage.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `issue-factory`: two requirements added, "Triage closes an issue with nothing to change" and
  "A run held for its paths is triaged again when those files changed".
