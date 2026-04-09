import { EventEmitter } from 'events';

import CDP from 'chrome-remote-interface';

export interface ScreencastFrame {
  data: string; // base64 JPEG
  timestamp: number;
  sessionId: number;
}

export interface ChromeSessionOptions {
  host?: string;
  port?: number;
  format?: 'jpeg' | 'png';
  quality?: number;
  maxWidth?: number;
  maxHeight?: number;
  everyNthFrame?: number;
}

export class ChromeSession extends EventEmitter {
  private client: CDP.Client | null = null;
  private options: Required<ChromeSessionOptions>;
  private frameCount = 0;
  private connected = false;

  constructor(options: ChromeSessionOptions = {}) {
    super();
    this.options = {
      host: options.host ?? 'localhost',
      port: options.port ?? 9222,
      format: options.format ?? 'jpeg',
      quality: options.quality ?? 80,
      maxWidth: options.maxWidth ?? 1280,
      maxHeight: options.maxHeight ?? 720,
      everyNthFrame: options.everyNthFrame ?? 1,
    };
  }

  async connect(): Promise<void> {
    const { host, port } = this.options;
    this.emit('log', `Connecting to Chrome at ${host}:${port}...`);

    // Connect to the first page-level target rather than the browser-level
    // WebSocket. Chrome only allows one browser-level CDP connection at a time,
    // and Playwright's connectOverCDP also needs that slot — so we take the
    // page target slot instead, which is independent and doesn't conflict.
    const targets: CDP.Target[] = await CDP.List({ host, port });
    const pageTarget = targets.find((t) => t.type === 'page');

    if (pageTarget?.webSocketDebuggerUrl) {
      this.emit('log', `Using page target: ${pageTarget.id}`);
      this.client = await CDP({ target: pageTarget.webSocketDebuggerUrl });
    } else {
      this.emit('log', 'No page target found, connecting at browser level...');
      this.client = await CDP({ host, port });
    }

    const { Page } = this.client;

    await Page.enable();
    this.connected = true;
    this.emit('log', 'Connected. Starting screencast...');

    await Page.startScreencast({
      format: this.options.format,
      quality: this.options.quality,
      maxWidth: this.options.maxWidth,
      maxHeight: this.options.maxHeight,
      everyNthFrame: this.options.everyNthFrame,
    });

    Page.screencastFrame(async ({ data, metadata, sessionId }) => {
      this.frameCount++;
      const frame: ScreencastFrame = {
        data,
        timestamp: metadata.timestamp ?? Date.now() / 1000,
        sessionId,
      };
      this.emit('frame', frame);

      // Acknowledge frame so Chrome keeps sending
      await Page.screencastFrameAck({ sessionId }).catch(() => {});
    });

    this.client.on('disconnect', () => {
      this.connected = false;
      this.emit('log', 'Disconnected from Chrome.');
      this.emit('disconnect');
    });

    // Emit page events for debugging
    Page.loadEventFired(() => this.emit('pageLoad'));
    Page.navigatedWithinDocument(({ url }) => this.emit('navigate', url));

    // Enable console, network, and error capture
    await this.enableDebugDomains();

    this.emit('connected');
  }

  async navigate(url: string): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    await this.client.Page.navigate({ url });
    this.emit('log', `Navigated to ${url}`);
  }

  async execute(expression: string): Promise<unknown> {
    if (!this.client) throw new Error('Not connected');
    const result = await this.client.Runtime.evaluate({
      expression,
      returnByValue: true,
    });
    return result.result.value;
  }

  async screenshot(): Promise<string> {
    if (!this.client) throw new Error('Not connected');
    const { data } = await this.client.Page.captureScreenshot({
      format: 'png',
    });
    return data;
  }

  // ── Input events ────────────────────────────────────────────────────────────

  async dispatchMouseEvent(params: {
    type: 'mouseMoved' | 'mousePressed' | 'mouseReleased' | 'mouseWheel';
    x: number;
    y: number;
    button?: 'none' | 'left' | 'middle' | 'right';
    clickCount?: number;
    deltaX?: number;
    deltaY?: number;
    modifiers?: number;
  }): Promise<void> {
    if (!this.client) return;
    await this.client.Input.dispatchMouseEvent({
      button: 'none',
      clickCount: 0,
      deltaX: 0,
      deltaY: 0,
      modifiers: 0,
      ...params,
    }).catch(() => {});
  }

  async dispatchKeyEvent(params: {
    type: 'keyDown' | 'keyUp' | 'char';
    key: string;
    code: string;
    text?: string;
    modifiers?: number;
    windowsVirtualKeyCode?: number;
    nativeVirtualKeyCode?: number;
  }): Promise<void> {
    if (!this.client) return;
    await this.client.Input.dispatchKeyEvent({
      modifiers: 0,
      ...params,
    }).catch(() => {});
  }

  async dispatchScroll(x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
    await this.dispatchMouseEvent({
      type: 'mouseWheel',
      x,
      y,
      deltaX,
      deltaY,
    });
  }

  private async enableDebugDomains(): Promise<void> {
    if (!this.client) return;
    const { Runtime, Network, Log } = this.client;

    // Console messages via Runtime.consoleAPICalled
    await Runtime.enable().catch(() => {});
    Runtime.consoleAPICalled(({ type, args, timestamp, stackTrace }) => {
      const text = args.map((a: any) => a.value ?? a.description ?? '').join(' ');
      const frame = stackTrace?.callFrames?.[0];
      this.emit('console', {
        level: type as string,
        text,
        url: frame?.url,
        line: frame?.lineNumber,
        column: frame?.columnNumber,
        timestamp: timestamp ?? Date.now(),
      });
    });

    // JavaScript exceptions
    Runtime.exceptionThrown(({ timestamp, exceptionDetails }) => {
      const ex = exceptionDetails;
      const text = ex.exception?.description ?? ex.text ?? 'Unknown error';
      this.emit('error', {
        message: text,
        source: ex.url,
        line: ex.lineNumber,
        column: ex.columnNumber,
        stack: ex.stackTrace
          ? ex.stackTrace.callFrames
              .map(
                (f: any) =>
                  `  at ${f.functionName || '(anonymous)'} (${f.url}:${f.lineNumber}:${f.columnNumber})`,
              )
              .join('\n')
          : undefined,
        timestamp: timestamp ?? Date.now(),
      });
    });

    // Network requests — register event handlers FIRST so live events are never missed
    await Network.enable().catch(() => {});

    Network.requestWillBeSent(({ requestId, request, timestamp, type }) => {
      this.emit('network', {
        entry: {
          id: requestId,
          method: request.method,
          url: request.url,
          resourceType: type,
          startTime: timestamp * 1000,
          requestHeaders: request.headers as Record<string, string>,
          postData: request.postData,
        },
        phase: 'request' as const,
      });
    });

    Network.responseReceived(({ requestId, response, timestamp, type }) => {
      this.emit('network', {
        entry: {
          id: requestId,
          method: '',
          url: response.url,
          status: response.status,
          statusText: response.statusText,
          resourceType: type,
          mimeType: response.mimeType,
          endTime: timestamp * 1000,
          responseHeaders: response.headers as Record<string, string>,
        },
        phase: 'response' as const,
      });
    });

    try {
      Network.loadingFinished(({ requestId, timestamp, encodedDataLength }: any) => {
        this.emit('network', {
          entry: {
            id: requestId,
            method: '',
            url: '',
            endTime: timestamp * 1000,
            size: encodedDataLength,
          },
          phase: 'completed' as const,
        });

        // Fetch response body asynchronously (fire-and-forget)
        Network.getResponseBody({ requestId })
          .then(({ body, base64Encoded }: any) => {
            if (body) {
              this.emit('network', {
                entry: {
                  id: requestId,
                  method: '',
                  url: '',
                  startTime: 0,
                  responseBody: body,
                  responseBodyBase64: base64Encoded,
                },
                phase: 'completed' as const,
              });
            }
          })
          .catch(() => {
            // Response body not available (e.g. redirects, cancelled)
          });
      });
    } catch {
      // loadingFinished may not be available in all CDP implementations
    }

    Network.loadingFailed(({ requestId, timestamp, errorText, type }) => {
      this.emit('network', {
        entry: {
          id: requestId,
          method: '',
          url: '',
          resourceType: type,
          startTime: timestamp * 1000,
          failed: true,
          errorText,
        },
        phase: 'failed' as const,
      });
    });

    // Browser-level log entries (e.g. security warnings, deprecation notices)
    await Log.enable().catch(() => {});
    Log.entryAdded(({ entry }) => {
      this.emit('error', {
        message: entry.text,
        source: entry.url,
        line: entry.lineNumber,
        timestamp: entry.timestamp ?? Date.now(),
      });
    });

    // Backfill resources that loaded before CDP connected (JS, CSS, images, etc.)
    // Fire-and-forget so it never blocks event handler registration above
    this.backfillResourceTree().catch(() => {});
  }

  private async backfillResourceTree(): Promise<void> {
    if (!this.client) return;
    const { frameTree } = await this.client.Page.getResourceTree();
    const now = Date.now();
    const resources = frameTree.resources ?? [];
    for (const res of resources) {
      const id = `backfill-${res.url}`;
      this.emit('network', {
        entry: {
          id,
          method: 'GET',
          url: res.url,
          status: res.failed ? 0 : 200,
          resourceType: res.type,
          mimeType: res.mimeType,
          size: (res as any).contentSize ?? undefined,
          startTime: now,
          endTime: now,
          duration: 0,
          failed: res.failed ?? false,
        },
        phase: 'request' as const,
      });
    }
  }

  getStats() {
    return {
      connected: this.connected,
      framesReceived: this.frameCount,
      host: this.options.host,
      port: this.options.port,
    };
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.Page.stopScreencast().catch(() => {});
      await this.client.close();
      this.client = null;
      this.connected = false;
    }
  }
}

/**
 * Wait until Chrome's debugging port is accepting connections.
 */
export async function waitForChrome(host: string, port: number, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://${host}:${port}/json/version`);
      if (res.ok) {
        return;
      }
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  throw new Error(`[waitForChrome] Timeout: Chrome not ready after ${timeoutMs}ms`);
}
