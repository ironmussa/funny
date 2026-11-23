# Design

## Context

- `/factory` (`FactoryQueueView.tsx`) lists `useFactoryQueueRuns()` as a list or the board from
  `factory-pipeline-board`. Every `FactoryQueueRun` already carries what the panel shows:
  `triage` (decision, contract, items, thread), `reviews[]` (one per commit: sha, verdict,
  summary, findings, reviewer thread, `carriedFrom`), `regressionProof`, `risk`, `metrics`,
  `stepOptions` (step → thread, model), `threadIds`, `failureReason`, `flowSource` / `flowCommit`.
- Pieces to reuse: `FactoryRunProgress` and the waiting text from the board;
  `RegressionProofDetails` (private in `thread/FactoryRunProofCard.tsx`); `ProjectFactoryRunFlow`
  (flow source + step options); `ProjectFactoryIncident` (incident banner with its close action,
  test ids prefixed `settings-`); `summarizeFactoryRuns` (30-day settings metrics, not the same
  figures); `FactoryRunControls`.
- The incident lives on `FactorySettings`, read per project with `useFactorySettings(projectId)`;
  the queue answer does not carry it.
- The queue lists runs that have not ended, or ended in the last 14 days, so 7-day figures are
  complete; 30-day ones would not be.

## Goals / Non-Goals

**Goals:**

- The panel is a pure function of one `FactoryQueueRun` plus thread titles: no request of its own.
- Section components small and individually testable (keeps the fallow complexity gate).

**Non-Goals:**

- Time per step (needs the server to record step start / end).
- The test-weakening result (not on `FactoryRun`).
- Editing anything from the panel beyond the existing run controls and closing an incident.

## Decisions

### D1. A shadcn `Sheet` driven by the `run` search parameter

`useFactoryRunParam()` reads / writes `?run=` with `useSearchParams` (replace, not push, so
opening panels does not fill the history). The open run is looked up in the listed runs by id on
every render, so live updates flow in; an id not found clears the parameter in an effect (but only
once the runs have loaded: `undefined` runs mean loading, not missing). Alternative, local state:
rejected, the panel could not be linked or survive a reload. Alternative, a route
`/factory/runs/:id`: rejected, the panel sits over the list or board, which keeps its filters.

### D2. The card opens the panel; the list row keeps opening the thread

`FactoryBoard`'s `onOpen` becomes `onSelect(run)`. The list row gets a details icon button
(`factory-view-details-<id>`) next to its controls. The thread stays one click away in the panel's
header ("Open thread", `implementingThreadOf(run) ?? latest`).

### D3. Sections

`run-detail/FactoryRunDetail.tsx` composes one component per section, each returning null when
the run has not reached it: `RunHeader`, `RunFlow` (strip + `ProjectFactoryRunFlow`),
`RunTriage`, `RunProof` (exported `RegressionProofDetails`), `RunReviews` (one `ReviewEntry` per
verdict: short sha, carried-from, verdict badge via the same pass rule as
`factoryRunReviewLabel`, summary, findings sorted by severity with `path:line`), `RunRiskCi`,
`RunOutcome` (the board's `factoryRunWaitingText`). A `ThreadLink` button navigates to a thread
(`getThreadRoute`) and closes the panel. `thread-links.ts` (pure) lists the run's agent threads
with their step: triage's thread, each `stepOptions` entry, each review's thread, de-duplicated.

### D4. Health summary is pure and windowed on the listed runs

`factory-board/factory-health.ts`: `summarizeFactoryHealth(runs, now)` → `{ inFlight,
needsPerson, mergedLastDay, firstPassReviewRate, mergeHolds, medianToMergeMs }`. In flight =
board columns Triage through Merge (reuses `factoryBoardColumn`); needs a person = that column;
first pass = `reviews[0]` passes, among runs started in 7 days with `reviews.length > 0`; merge
holds = sum of `metrics.mergeHolds` over those runs; median to merge over runs merged in 7 days.
It uses the unfiltered runs, so the header does not change with the filters (the spec says
"whatever the filters"). Rendered as a row of compact stats in `FactoryQueueHeader`.

### D5. Incident banners per project

`FactoryIncidentBanners` renders one `ProjectIncidentBanner` per project id that has listed runs;
each calls `useFactorySettings(projectId)` and renders `ProjectFactoryIncident` when
`settings.incident` is set. `ProjectFactoryIncident` gets an optional `testIdPrefix` (default
`settings-factory-incident`, so settings tests keep their ids); the view passes
`factory-view-incident-<projectId>`. Settings are already cached by the data layer, and a member
has few factories, so one query per project is acceptable.

## Risks / Trade-offs

- [One settings query per project with runs] → cached per project by the data layer and shared
  with the settings screen; the number of projects with factory runs is small.
- [`factory-integration` (in flight) adds a batch and queue position to runs] → the panel's
  sections are independent components; that change adds a section for its batch without touching
  these.
- [A run leaves the list (ended more than 14 days ago) while its panel is open] → the panel closes
  and the parameter is cleared, as for any unknown id.

## Migration Plan

Client-only; rollback is reverting the change.
