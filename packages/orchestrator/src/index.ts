/**
 * @funny/thread-orchestrator — orchestrator brain + pipeline dispatcher.
 *
 * Two pieces:
 *   - `OrchestratorService` (./service) — the brain: poll/reconcile loops,
 *     priority queue, stall detection, claim/dispatch/release lifecycle.
 *     Defines the `Dispatcher`, `ThreadQueryAdapter`, `OrchestratorRunRepository`
 *     contracts.
 *   - `OrchestratorPipelineDispatcher` (./dispatcher) — runs a YAML pipeline
 *     for a single thread (one production wiring of `Dispatcher`).
 *
 * Plus HTTP adapters under ./adapters/* for the standalone brain to talk
 * to a remote funny server via `/api/orchestrator/system/*`.
 */

// ── Brain (service) ────────────────────────────────────────
export {
  OrchestratorService,
  defaultOrchestratorConfig,
  type DispatchError,
  type DispatchHandle,
  type DispatchOutcome,
  type DispatchResult,
  type Dispatcher,
  type OrchestratorConfig,
  type OrchestratorEmitter,
  type OrchestratorLogger,
  type OrchestratorServiceDeps,
  type ThreadQueryAdapter,
  type TickSummary,
} from './service.js';

// ── Pipeline dispatcher (per-thread runner) ────────────────
//
// Note: dispatcher.ts has its own DispatchHandle/Outcome/Result types
// (with `lastEventAt` for stall detection). We rename those here to
// avoid a clash with the service-level ones above.
export {
  OrchestratorPipelineDispatcher,
  type ContextBuilder,
  type DispatchInput,
  type DispatcherLogger,
  type OrchestratorPipelineDispatcherDeps,
  type PipelineLoader,
  type PipelineLoaderScope,
  type DispatchHandle as PipelineDispatchHandle,
  type DispatchOutcome as PipelineDispatchOutcome,
  type DispatchResult as PipelineDispatchResult,
} from './dispatcher.js';

// ── HTTP adapters ──────────────────────────────────────────
export { HttpOrchestratorClient, type HttpClientOptions } from './adapters/http-client.js';
export { HttpOrchestratorRunRepository } from './adapters/http-run-repository.js';
export { HttpThreadQueryAdapter } from './adapters/http-thread-query.js';
export {
  HttpEventStream,
  type HttpEventStreamOptions,
  type EventStreamEvent,
} from './adapters/http-event-stream.js';
export { HttpDispatcher, type HttpDispatcherOptions } from './adapters/http-dispatcher.js';
export {
  HttpOrchestratorEmitter,
  type HttpOrchestratorEmitterOptions,
} from './adapters/http-emitter.js';

// ── Standalone composition + logger ────────────────────────
export { buildStandalone, type StandaloneConfig, type StandaloneInstance } from './standalone.js';
export { createConsoleLogger, type ConsoleLoggerOptions, type LogFormat } from './logger.js';
