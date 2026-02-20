import { useCallback, useEffect, useRef } from 'react';
import { api } from '@/lib/api';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  level: LogLevel;
  message: string;
  attributes?: Record<string, string>;
}

const FLUSH_INTERVAL_MS = 5_000;
const MAX_BATCH_SIZE = 25;

/** Batched buffer shared across all hook instances. */
const buffer: LogEntry[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let listenerInstalled = false;

function flush() {
  if (buffer.length === 0) return;
  const batch = buffer.splice(0, buffer.length);
  api.sendLogs(batch); // fire-and-forget
}

function enqueue(entry: LogEntry) {
  buffer.push(entry);
  if (buffer.length >= MAX_BATCH_SIZE) flush();
}

function ensureGlobalListeners() {
  if (listenerInstalled) return;
  listenerInstalled = true;

  // Capture unhandled errors
  window.addEventListener('error', (event) => {
    enqueue({
      level: 'error',
      message: event.message || 'Unhandled error',
      attributes: {
        'error.filename': event.filename || '',
        'error.lineno': String(event.lineno || 0),
        'error.colno': String(event.colno || 0),
      },
    });
  });

  // Capture unhandled promise rejections
  window.addEventListener('unhandledrejection', (event) => {
    const message = event.reason instanceof Error
      ? event.reason.message
      : String(event.reason);
    enqueue({
      level: 'error',
      message: `Unhandled rejection: ${message}`,
    });
  });

  // Flush before page unload
  window.addEventListener('beforeunload', flush);

  // Periodic flush
  flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);
}

/**
 * Hook that provides a logger for sending frontend logs to the observability stack.
 * Logs are batched and sent periodically to POST /api/logs.
 *
 * Usage:
 *   const log = useLogger('ComponentName');
 *   log.info('User clicked button');
 *   log.error('Failed to load data', { 'api.endpoint': '/projects' });
 */
export function useLogger(namespace?: string) {
  const nsRef = useRef(namespace);
  nsRef.current = namespace;

  useEffect(() => {
    ensureGlobalListeners();
  }, []);

  const createLogFn = useCallback((level: LogLevel) => {
    return (message: string, attributes?: Record<string, string>) => {
      const attrs: Record<string, string> = { ...attributes };
      if (nsRef.current) attrs['log.namespace'] = nsRef.current;
      enqueue({ level, message, attributes: attrs });
    };
  }, []);

  return {
    debug: createLogFn('debug'),
    info: createLogFn('info'),
    warn: createLogFn('warn'),
    error: createLogFn('error'),
  };
}
