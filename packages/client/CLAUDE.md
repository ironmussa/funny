# packages/client — CLAUDE.md

## Logging & Telemetry

**Always send logs to Abbacchio.** When adding new functionality, error handling, or debug output, use the existing client-side logger and telemetry utilities so that logs, metrics, and traces are sent to Abbacchio via OTLP.

- **Logs:** Use `createClientLogger(namespace)` from `@/lib/client-logger.ts` (`@abbacchio/browser-transport`). Create a namespaced logger per module/store.
- **Metrics/Traces:** Use `metric()` and `startSpan()` from `@/lib/telemetry.ts` for recording metrics and traces with W3C Trace Context propagation.
- Do NOT use bare `console.log` / `console.error` — always prefer the structured logger so output reaches Abbacchio.
- When creating new stores, hooks, or significant UI interactions, add relevant log calls and spans (e.g., API call duration, user action traces).
