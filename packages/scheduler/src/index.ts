/**
 * @funny/thread-scheduler — scheduler brain + pipeline dispatcher.
 *
 * Two pieces:
 *   - `SchedulerService` (./service) — the brain: poll/reconcile loops,
 *     priority queue, stall detection, claim/dispatch/release lifecycle.
 *     Defines the `Dispatcher`, `ThreadQueryAdapter`, `SchedulerRunRepository`
 *     contracts.
 *   - `SchedulerPipelineDispatcher` (./dispatcher) — runs a YAML pipeline
 *     for a single thread (one production wiring of `Dispatcher`).
 *
 * Plus HTTP adapters under ./adapters/* for the standalone brain to talk
 * to a remote funny server via `/api/scheduler/system/*`.
 */

// ── Brain (service) ────────────────────────────────────────
export {
  SchedulerService,
  defaultSchedulerConfig,
  type DispatchError,
  type DispatchHandle,
  type DispatchOutcome,
  type DispatchResult,
  type Dispatcher,
  type SchedulerConfig,
  type SchedulerEmitter,
  type SchedulerLogger,
  type SchedulerServiceDeps,
  type ThreadQueryAdapter,
  type TickSummary,
} from './service.js';

// ── Pipeline dispatcher (per-thread runner) ────────────────
//
// Note: dispatcher.ts has its own DispatchHandle/Outcome/Result types
// (with `lastEventAt` for stall detection). We rename those here to
// avoid a clash with the service-level ones above.
export {
  SchedulerPipelineDispatcher,
  type ContextBuildMeta,
  type ContextBuilder,
  type DispatchInput,
  type DispatcherLogger,
  type SchedulerPipelineDispatcherDeps,
  type PipelineInputDefinition,
  type PipelineLoader,
  type PipelineLoadResult,
  type PipelineLoaderScope,
  type DispatchHandle as PipelineDispatchHandle,
  type DispatchOutcome as PipelineDispatchOutcome,
  type DispatchResult as PipelineDispatchResult,
} from './dispatcher.js';

// ── HTTP adapters ──────────────────────────────────────────
export { HttpSchedulerClient, type HttpClientOptions } from './adapters/http-client.js';
export { HttpSchedulerRunRepository } from './adapters/http-run-repository.js';
export { HttpThreadQueryAdapter } from './adapters/http-thread-query.js';
export {
  HttpEventStream,
  type HttpEventStreamOptions,
  type EventStreamEvent,
} from './adapters/http-event-stream.js';
export { HttpDispatcher, type HttpDispatcherOptions } from './adapters/http-dispatcher.js';
export { HttpSchedulerEmitter, type HttpSchedulerEmitterOptions } from './adapters/http-emitter.js';

// ── Standalone composition + logger ────────────────────────
export { buildStandalone, type StandaloneConfig, type StandaloneInstance } from './standalone.js';
export { createConsoleLogger, type ConsoleLoggerOptions, type LogFormat } from './logger.js';
