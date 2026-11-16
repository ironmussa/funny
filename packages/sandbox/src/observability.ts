/**
 * Logging and metrics the sandbox layer reports through. The package never
 * imports a host's logger or telemetry: the server (or the issue factory)
 * passes its own, and without one the reports are dropped.
 */

export type SandboxLogFields = Record<string, unknown>;

export interface SandboxLogger {
  info(message: string, fields?: SandboxLogFields): void;
  warn(message: string, fields?: SandboxLogFields): void;
}

export interface SandboxMetricOptions {
  type?: 'sum' | 'gauge';
  unit?: string;
  attributes?: Record<string, string>;
}

export type SandboxMetric = (name: string, value: number, options?: SandboxMetricOptions) => void;

export interface SandboxObservability {
  log?: SandboxLogger;
  metric?: SandboxMetric;
}

const silentLogger: SandboxLogger = { info: () => {}, warn: () => {} };
const silentMetric: SandboxMetric = () => {};

/** The given logger and metric sink, with silent ones in place of what is missing. */
export function resolveObservability(
  observability: SandboxObservability = {},
): Required<SandboxObservability> {
  return {
    log: observability.log ?? silentLogger,
    metric: observability.metric ?? silentMetric,
  };
}
