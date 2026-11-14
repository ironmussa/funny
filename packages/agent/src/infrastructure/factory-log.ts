/**
 * The orchestrator's log: plain lines on its output, every one passed through
 * the secret redactor first, so a secret cannot reach a terminal or a log file
 * through any message or field.
 */

export type LogFields = Record<string, unknown>;

export interface FactoryLog {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

const formatFields = (fields?: LogFields) =>
  fields && Object.keys(fields).length > 0
    ? ` ${Object.entries(fields)
        .map(
          ([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`,
        )
        .join(' ')}`
    : '';

export function createFactoryLog(
  write: { out: (text: string) => void; err: (text: string) => void },
  redact: (text: string) => string,
): FactoryLog {
  const line = (sink: (text: string) => void, message: string, fields?: LogFields) =>
    sink(`${redact(`${message}${formatFields(fields)}`)}\n`);
  return {
    info: (message, fields) => line(write.out, message, fields),
    warn: (message, fields) => line(write.err, message, fields),
    error: (message, fields) => line(write.err, message, fields),
  };
}
