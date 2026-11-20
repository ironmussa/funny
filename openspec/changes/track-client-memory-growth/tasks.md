## 1. Diagnostic Core

- [x] 1.1 Implement bounded, value-only memory sampling and JSONL serialization
- [x] 1.2 Expose the development-only console lifecycle API with HMR cleanup

## 2. Browser Panel Correlation

- [x] 2.1 Add constant-time cumulative frame and decode lifecycle counters
- [x] 2.2 Wire frame receipt, decode completion/failure, and session cleanup into the Browser Panel path

## 3. Verification and Runbook

- [x] 3.1 Add unit tests for retention bounds, copies, serialization, profiler lifecycle, and frame counters
- [x] 3.2 Document profiler commands, the controlled experiment, and result interpretation
- [x] 3.3 Run focused tests, React Doctor regression scan, lint, and typecheck

## 4. Extract to Abbacchio

- [x] 4.1 Add the configurable bounded profiler, public exports, tests, and usage documentation to `@abbacchio/browser-transport`
- [x] 4.2 Replace Funny's profiler implementation with an Abbacchio development-only installation and Funny-specific collectors
- [x] 4.3 Remove Funny's duplicated profiler source/tests and update its runbook and dependency
- [x] 4.4 Run package tests/builds and Funny's required lint and typecheck gates
- [ ] 4.5 Publish `@abbacchio/browser-transport@0.3.0` and regenerate Funny's lockfile against the released package

## 5. Durable Runs

- [x] 5.1 Add a run identifier, a failure-isolated sample sink, and sample-to-gauge conversion to `@abbacchio/browser-transport`
- [x] 5.2 Publish Funny's samples as `client.memory.*` gauges and install the profiler wherever OTLP is configured
- [x] 5.3 Add unit tests for run identity, sink isolation, metric conversion, and Funny's publisher
- [x] 5.4 Document persistence and the SQL query recipes in the Abbacchio guide and Funny's runbook
- [x] 5.5 Run package tests/builds and Funny's required lint, typecheck, and build gates
