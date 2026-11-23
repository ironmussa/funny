# Proposal

## Why

The factory board (`factory-pipeline-board`) shows where each run is, but not its story: what triage
decided, what each reviewer found on each commit, what the regression proof ran, which thread did
what. A card opens only the implementing thread, so following a run that went through two review
rounds means hunting for the reviewer threads by hand. The view also says nothing about the
factory as a whole: a red base branch that paused every admission (the sentinel's incident) and
how well the pipeline is flowing are visible only in each project's settings.

## What Changes

- **Run detail panel.** Activating a board card (or the new details button on a list row) opens a
  side panel for the run, linkable by URL (`/factory?run=<id>`). It shows, in pipeline order: the
  issue and its state with the run's controls; the flow strip and where the flow came from;
  triage's decision (the contract's criteria, or the questions asked, or the proposed split); the
  implementing agent; the regression proof; one entry per review verdict (commit, verdict, summary,
  findings with severity and location); the risk class and its reasons; CI rounds; and why it
  parked or failed. Every agent step links to its own thread.
- The list row keeps opening the run's thread; the board card opens the panel instead (the panel
  links to the thread).
- **Factory health header.** The view's header shows, over the runs it lists: runs in flight, runs
  needing a person, merged in the last 24 hours, first-pass review rate and merge holds over the
  last 7 days, and the median time to merge. A banner for each project whose factory has an open
  incident (base branch red after a factory merge) shows what the sentinel found and lets a member
  close it, as the project settings already do.

No server, API or data-model change: all of it comes from `FactoryQueueRun` and the per-project
factory settings the client already loads.

## Capabilities

### New Capabilities

<!-- None. -->

### Modified Capabilities

- `factory-pipeline-board`: adds the run detail panel, its URL, the card opening it, and the
  factory health header with incident banners.

## Impact

- New `packages/client/src/components/factory-board/run-detail/` (panel and its sections) and a
  pure `factory-health.ts` summary (with unit tests).
- `FactoryQueueView.tsx` (header, `run` search param, list row details button), `FactoryRunCard.tsx`
  (opens the panel).
- `thread/FactoryRunProofCard.tsx` exports its proof details for reuse;
  `general-settings-project/ProjectFactoryIncident.tsx` gets a test id prefix so it can render in
  both places.
- Locales (`en`, `es`, `pt`), stories, `openwiki/architecture/issue-factory.md`.
