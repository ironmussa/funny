# Tasks

## 1. Pure helpers

- [x] 1.1 Add `factory-board/factory-health.ts` (`summarizeFactoryHealth`, D4) with unit tests: in flight and needs-a-person counts, merged in the last 24 hours, first-pass rate (67% case, dash with no reviews), merge holds and median to merge over 7 days only.
- [x] 1.2 Add `factory-board/run-detail/thread-links.ts` (the run's agent threads with their step, D3) with unit tests: triage, implementer continued across steps, one reviewer per verdict, duplicates removed.

## 2. Panel

- [x] 2.1 Export `RegressionProofDetails` from `thread/FactoryRunProofCard.tsx` and add `testIdPrefix` to `ProjectFactoryIncident` (default unchanged); verify the existing proof card and settings incident tests still pass.
- [x] 2.2 Build the section components and `FactoryRunDetail` (D3) inside a shadcn `Sheet`, with `data-testid`s; component tests for the two-review-rounds and needs-info scenarios, a run with nothing reached yet, and the thread links.
- [x] 2.3 Add `useFactoryRunParam` (D1) and wire it in `FactoryQueueView`: the card opens the panel (D2), the list row gets a details button, an unknown id clears the parameter after loading, the panel follows live updates; component tests for each spec scenario.

## 3. Health header

- [x] 3.1 Render the health stats in the view's header from `summarizeFactoryHealth` over the unfiltered runs; component test that the figures ignore the filters.
- [x] 3.2 Render `FactoryIncidentBanners` (D5) above the layouts; component test with an incident on one of two projects (banner, links, close action) and none without.

## 4. Docs, strings and stories

- [x] 4.1 Add the `en`, `es`, `pt` strings; Storybook stories for the panel (every section reached, a fresh run) and for the header with an incident.
- [x] 4.2 Document the panel, its URL and the health header in `openwiki/architecture/issue-factory.md` (The factory view).

## 5. Verification

- [x] 5.1 Run `bun run lint`, `bun run typecheck`, the client suite, the factory stories and `bunx fallow audit --base origin/master`; all pass.
- [x] 5.2 Check the panel and header in Storybook in light and dark themes and at the smallest and largest font sizes.
