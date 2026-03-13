/**
 * Simple console logger for the central server.
 * Avoids heavy dependencies like winston — the central is a lightweight service.
 */

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

function formatMsg(level: LogLevel, message: string, meta?: Record<string, unknown>): string {
  const ts = new Date().toISOString();
  const ns = meta?.namespace ? `[${meta.namespace}]` : '';
  const extra = meta
    ? Object.entries(meta)
        .filter(([k]) => k !== 'namespace')
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(' ')
    : '';
  return `${ts} ${level.toUpperCase()} ${ns} ${message} ${extra}`.trim();
}

export const log = {
  info(message: string, meta?: Record<string, unknown>) {
    console.log(formatMsg('info', message, meta));
  },
  warn(message: string, meta?: Record<string, unknown>) {
    console.warn(formatMsg('warn', message, meta));
  },
  error(message: string, meta?: Record<string, unknown>) {
    console.error(formatMsg('error', message, meta));
  },
  debug(message: string, meta?: Record<string, unknown>) {
    if (process.env.LOG_LEVEL === 'debug') {
      console.debug(formatMsg('debug', message, meta));
    }
  },
};
