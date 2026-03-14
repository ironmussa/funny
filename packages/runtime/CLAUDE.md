# packages/runtime — CLAUDE.md

## Logging & Telemetry

**Always send logs to Abbacchio.** When adding new functionality, error handling, or debug output, use the existing logger and telemetry utilities so that logs, metrics, and traces are sent to Abbacchio via OTLP.

- **Logs:** Use `log` from `src/lib/logger.ts` (Winston with `AbbacchioWinstonTransport`). Always include a `namespace` field to identify the module.
- **Metrics/Traces:** Use `metric()`, `startSpan()`, `recordHistogram()`, and related helpers from `src/lib/telemetry.ts` (`@abbacchio/transport`). Use thread-scoped trace context (`setThreadTrace`, `getThreadTrace`) to correlate spans across modules.
- Do NOT use bare `console.log` / `console.error` — always prefer the structured logger so output reaches Abbacchio.
- When creating new services, handlers, or agent integrations, add relevant spans and metrics (e.g., agent run duration, tool call counts, error rates).
