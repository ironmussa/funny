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
    console.log(`[ChromeSession] Connecting to Chrome at ${host}:${port}...`);

    // Connect to the first page-level target rather than the browser-level
    // WebSocket. Chrome only allows one browser-level CDP connection at a time,
    // and Playwright's connectOverCDP also needs that slot — so we take the
    // page target slot instead, which is independent and doesn't conflict.
    const targets: CDP.Target[] = await CDP.List({ host, port });
    const pageTarget = targets.find((t) => t.type === 'page');

    if (pageTarget?.webSocketDebuggerUrl) {
      console.log(`[ChromeSession] Using page target: ${pageTarget.id}`);
      this.client = await CDP({ target: pageTarget.webSocketDebuggerUrl });
    } else {
      console.log('[ChromeSession] No page target found, connecting at browser level...');
      this.client = await CDP({ host, port });
    }

    const { Page } = this.client;

    await Page.enable();
    this.connected = true;
    console.log('[ChromeSession] Connected. Starting screencast...');

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
      console.log('[ChromeSession] Disconnected from Chrome.');
      this.emit('disconnect');
    });

    // Emit page events for debugging
    Page.loadEventFired(() => this.emit('pageLoad'));
    Page.navigatedWithinDocument(({ url }) => this.emit('navigate', url));

    this.emit('connected');
  }

  async navigate(url: string): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    await this.client.Page.navigate({ url });
    console.log(`[ChromeSession] Navigated to ${url}`);
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
 * Useful when Chrome is starting up inside the container.
 */
export async function waitForChrome(host: string, port: number, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  console.log(`[waitForChrome] Waiting for Chrome at ${host}:${port}...`);

  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://${host}:${port}/json/version`);
      if (res.ok) {
        console.log('[waitForChrome] Chrome is ready.');
        return;
      }
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  throw new Error(`[waitForChrome] Timeout: Chrome not ready after ${timeoutMs}ms`);
}
