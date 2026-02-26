import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import type { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import type { Resource } from '@opentelemetry/resources';
import { LoggerProvider, BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';

let loggerProvider: LoggerProvider | null = null;

export function initLogger(resource: Resource, exporter: OTLPLogExporter): void {
  loggerProvider = new LoggerProvider({ resource });
  loggerProvider.addLogRecordProcessor(new BatchLogRecordProcessor(exporter));
  logs.setGlobalLoggerProvider(loggerProvider);
}

export function getLogger(name = 'funny-server') {
  return logs.getLogger(name);
}

export async function shutdownLogger(): Promise<void> {
  if (loggerProvider) {
    await loggerProvider.shutdown();
    loggerProvider = null;
  }
}

/**
 * Emit a log record via OTLP.
 * Can be called from server code or from the /api/logs endpoint (for frontend logs).
 */
export function emitLog(
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  attributes?: Record<string, string | number | boolean>,
): void {
  const logger = getLogger();
  const severityMap: Record<string, SeverityNumber> = {
    debug: SeverityNumber.DEBUG,
    info: SeverityNumber.INFO,
    warn: SeverityNumber.WARN,
    error: SeverityNumber.ERROR,
  };

  logger.emit({
    severityNumber: severityMap[level] ?? SeverityNumber.INFO,
    severityText: level.toUpperCase(),
    body: message,
    attributes,
  });
}

export { SeverityNumber } from '@opentelemetry/api-logs';
