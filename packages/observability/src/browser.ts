/**
 * Vanilla JS browser logger — no framework dependencies.
 * Batches logs and sends them to an HTTP endpoint (e.g. POST /api/logs).
 * Works in any browser environment: React, Vue, Svelte, vanilla JS, etc.
 *
 * Usage:
 *   import { BrowserLogger } from '@funny/observability/browser';
 *
 *   const logger = new BrowserLogger({ endpoint: '/api/logs' });
 *   logger.info('Page loaded');
 *   logger.error('API call failed', { 'api.url': '/users' });
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  level: LogLevel;
  message: string;
  attributes?: Record<string, string>;
}

export interface BrowserLoggerOptions {
  /** HTTP endpoint to send logs to. Default: '/api/logs' */
  endpoint?: string;
  /** Flush interval in ms. Default: 5000 */
  flushIntervalMs?: number;
  /** Max batch size before auto-flush. Default: 25 */
  maxBatchSize?: number;
  /** Default attributes added to every log entry. */
  defaultAttributes?: Record<string, string>;
  /** Auth token for Authorization header (optional). */
  authToken?: string;
  /** Capture window.onerror and unhandledrejection automatically. Default: true */
  captureGlobalErrors?: boolean;
  /** Credentials mode for fetch. Default: 'same-origin' */
  credentials?: RequestCredentials;
  /** Custom headers to include with each request. */
  headers?: Record<string, string>;
}

export class BrowserLogger {
  private buffer: LogEntry[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private endpoint: string;
  private maxBatchSize: number;
  private defaultAttributes: Record<string, string>;
  private authToken?: string;
  private credentials: RequestCredentials;
  private customHeaders: Record<string, string>;

  constructor(options: BrowserLoggerOptions = {}) {
    this.endpoint = options.endpoint ?? '/api/logs';
    this.maxBatchSize = options.maxBatchSize ?? 25;
    this.defaultAttributes = options.defaultAttributes ?? {};
    this.authToken = options.authToken;
    this.credentials = options.credentials ?? 'same-origin';
    this.customHeaders = options.headers ?? {};

    const flushMs = options.flushIntervalMs ?? 5_000;
    this.flushTimer = setInterval(() => this.flush(), flushMs);

    if (typeof window !== 'undefined') {
      if (options.captureGlobalErrors !== false) {
        this.installGlobalHandlers();
      }
      window.addEventListener('beforeunload', () => this.flush());
    }
  }

  debug(message: string, attributes?: Record<string, string>): void {
    this.enqueue('debug', message, attributes);
  }

  info(message: string, attributes?: Record<string, string>): void {
    this.enqueue('info', message, attributes);
  }

  warn(message: string, attributes?: Record<string, string>): void {
    this.enqueue('warn', message, attributes);
  }

  error(message: string, attributes?: Record<string, string>): void {
    this.enqueue('error', message, attributes);
  }

  /** Force-flush all buffered logs immediately. */
  flush(): void {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0, this.buffer.length);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.customHeaders,
    };
    if (this.authToken) {
      headers['Authorization'] = `Bearer ${this.authToken}`;
    }
    // Fire-and-forget — don't block the caller
    fetch(this.endpoint, {
      method: 'POST',
      headers,
      credentials: this.credentials,
      body: JSON.stringify({ logs: batch }),
      keepalive: true, // survive page unload
    }).catch(() => {
      // Silently drop — observability should never break the app
    });
  }

  /** Stop the flush timer and flush remaining logs. */
  destroy(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
  }

  /** Create a child logger with additional default attributes. */
  child(attributes: Record<string, string>): BrowserLogger {
    const child = new BrowserLogger({
      endpoint: this.endpoint,
      maxBatchSize: this.maxBatchSize,
      flushIntervalMs: 0, // child shares parent's buffer
      defaultAttributes: { ...this.defaultAttributes, ...attributes },
      authToken: this.authToken,
      captureGlobalErrors: false, // only parent captures
      credentials: this.credentials,
      headers: this.customHeaders,
    });
    // Share buffer — child pushes to parent's buffer
    child.buffer = this.buffer;
    if (child.flushTimer) {
      clearInterval(child.flushTimer);
      child.flushTimer = null;
    }
    return child;
  }

  private enqueue(level: LogLevel, message: string, attributes?: Record<string, string>): void {
    this.buffer.push({
      level,
      message,
      attributes: { ...this.defaultAttributes, ...attributes },
    });
    if (this.buffer.length >= this.maxBatchSize) {
      this.flush();
    }
  }

  private installGlobalHandlers(): void {
    window.addEventListener('error', (event) => {
      this.error(event.message || 'Unhandled error', {
        'error.filename': event.filename || '',
        'error.lineno': String(event.lineno || 0),
        'error.colno': String(event.colno || 0),
      });
    });

    window.addEventListener('unhandledrejection', (event) => {
      const message = event.reason instanceof Error
        ? event.reason.message
        : String(event.reason);
      this.error(`Unhandled rejection: ${message}`);
    });
  }
}
