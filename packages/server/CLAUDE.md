# packages/server — CLAUDE.md

## Logging & Telemetry

**Always send logs to Abbacchio.** When adding new functionality, error handling, or debug output, use the existing logger and telemetry utilities so that logs, metrics, and traces are sent to Abbacchio via OTLP.

- **Logs:** Use `log` from `packages/runtime/src/lib/logger.ts` (Winston with `AbbacchioWinstonTransport`). Always include a `namespace` field to identify the module.
- **Metrics/Traces:** Use `metric()`, `startSpan()`, and related helpers from `packages/runtime/src/lib/telemetry.ts` (`@abbacchio/transport`).
- Do NOT use bare `console.log` / `console.error` — always prefer the structured logger so output reaches Abbacchio.
- When creating new services or route handlers, add relevant spans and metrics (e.g., request duration, error counts).
