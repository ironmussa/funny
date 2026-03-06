/**
 * RemotePage — Playwright-like API over chrome-remote-interface (page-level CDP).
 *
 * Uses a PAGE-level WebSocket connection, not the browser-level one.
 * This means it never conflicts with other CDP clients (including the
 * streaming server's screencast session).
 *
 * Usage:
 *   import { RemotePage } from '../lib/page.ts';
 *   const page = await RemotePage.connect();
 *   await page.goto('https://example.com');
 *   await page.click('button#submit');
 *   await page.close();
 */
import CDP from 'chrome-remote-interface';

export interface ConnectOptions {
  host?: string;
  port?: number;
}

type Rect = { x: number; y: number; width: number; height: number };

const KEY_MAP: Record<string, { code: string; keyCode: number }> = {
  Enter: { code: 'Enter', keyCode: 13 },
  Escape: { code: 'Escape', keyCode: 27 },
  Tab: { code: 'Tab', keyCode: 9 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  Space: { code: 'Space', keyCode: 32 },
};

export class RemotePage {
  private client: CDP.Client;

  private constructor(client: CDP.Client) {
    this.client = client;
  }

  // ── Factory ─────────────────────────────────────────────────────────────────

  static async connect(options: ConnectOptions = {}): Promise<RemotePage> {
    const host = options.host ?? process.env.CDP_HOST ?? 'localhost';
    const port = parseInt(String(options.port ?? process.env.CDP_PORT ?? '9222'));

    console.log(`[RemotePage] Connecting to ${host}:${port}...`);

    // Get the first page-level target
    const targets = await CDP.List({ host, port });
    const pageTarget = targets.find((t) => t.type === 'page');

    let client: CDP.Client;
    if (pageTarget?.webSocketDebuggerUrl) {
      console.log(`[RemotePage] Using page target: ${pageTarget.id}`);
      client = await CDP({ target: pageTarget.webSocketDebuggerUrl });
    } else {
      console.log('[RemotePage] No page target — falling back to browser level');
      client = await CDP({ host, port });
    }

    await client.Page.enable();
    await client.Runtime.enable();
    await client.DOM.enable();
    console.log('[RemotePage] Connected.');

    return new RemotePage(client);
  }

  // ── Navigation ───────────────────────────────────────────────────────────────

  async goto(
    url: string,
    options: { timeout?: number; waitUntil?: 'load' | 'domcontentloaded' } = {},
  ): Promise<void> {
    const timeout = options.timeout ?? 15_000;
    console.log(`[RemotePage] goto ${url}`);

    await Promise.race([
      (async () => {
        await this.client.Page.navigate({ url });
        await this._waitForLoad(timeout);
      })(),
      this._timeout(timeout, `goto("${url}")`),
    ]);
  }

  async url(): Promise<string> {
    return this._eval<string>('window.location.href');
  }

  async title(): Promise<string> {
    return this._eval<string>('document.title');
  }

  async goBack(): Promise<void> {
    await this._eval('history.back()');
    await this.sleep(500);
  }

  async goForward(): Promise<void> {
    await this._eval('history.forward()');
    await this.sleep(500);
  }

  async reload(): Promise<void> {
    await this.client.Page.reload();
    await this._waitForLoad(10_000);
  }

  // ── Waiting ──────────────────────────────────────────────────────────────────

  async waitForSelector(selector: string, timeout = 10_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const found = await this._eval<boolean>(
        `!!document.querySelector(${JSON.stringify(selector)})`,
      );
      if (found) return;
      await this.sleep(200);
    }
    throw new Error(`waitForSelector timeout: "${selector}" not found after ${timeout}ms`);
  }

  async waitForNavigation(timeout = 10_000): Promise<void> {
    await this._waitForLoad(timeout);
  }

  // ── Mouse interaction ────────────────────────────────────────────────────────

  async click(selector: string, options: { timeout?: number } = {}): Promise<void> {
    await this.waitForSelector(selector, options.timeout ?? 5_000);
    const rect = await this._boundingRect(selector);
    if (!rect) throw new Error(`click: element not found or not visible: "${selector}"`);

    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;

    await this._mouseMove(x, y);
    await this._mouseDown(x, y);
    await this.sleep(60);
    await this._mouseUp(x, y);
    await this.sleep(80);
  }

  async hover(selector: string): Promise<void> {
    await this.waitForSelector(selector);
    const rect = await this._boundingRect(selector);
    if (!rect) throw new Error(`hover: element not found: "${selector}"`);
    await this._mouseMove(rect.x + rect.width / 2, rect.y + rect.height / 2);
  }

  async scroll(
    deltaX: number,
    deltaY: number,
    origin: { x?: number; y?: number } = {},
  ): Promise<void> {
    const x = origin.x ?? 640;
    const y = origin.y ?? 360;
    await this.client.Input.dispatchMouseEvent({
      type: 'mouseWheel',
      x,
      y,
      deltaX,
      deltaY,
      button: 'none',
      clickCount: 0,
    });
    await this.sleep(80);
  }

  // ── Keyboard interaction ─────────────────────────────────────────────────────

  /**
   * Type text character by character.
   * Use `fill()` to set a value directly without key events.
   */
  async type(text: string, options: { delay?: number } = {}): Promise<void> {
    const delay = options.delay ?? 50;
    for (const char of text) {
      // keyDown with `text` handles character insertion; keyUp just releases.
      // Do NOT send a separate "char" event — that would double-insert.
      await this.client.Input.dispatchKeyEvent({ type: 'keyDown', key: char, text: char });
      await this.client.Input.dispatchKeyEvent({ type: 'keyUp', key: char });
      if (delay > 0) await this.sleep(delay);
    }
  }

  async press(key: string): Promise<void> {
    const info = KEY_MAP[key] ?? { code: key, keyCode: key.charCodeAt(0) };
    await this.client.Input.dispatchKeyEvent({
      type: 'keyDown',
      key,
      code: info.code,
      windowsVirtualKeyCode: info.keyCode,
    });
    await this.sleep(50);
    await this.client.Input.dispatchKeyEvent({
      type: 'keyUp',
      key,
      code: info.code,
      windowsVirtualKeyCode: info.keyCode,
    });
  }

  // ── Form helpers ─────────────────────────────────────────────────────────────

  /**
   * Clear and fill an input/textarea directly (sets .value + dispatches input/change events).
   * Faster than `type()` for long strings.
   */
  async fill(selector: string, value: string): Promise<void> {
    await this.waitForSelector(selector);
    await this.click(selector);
    await this.sleep(100);

    // Select all and delete existing content
    await this.press('End');
    await this._eval(`
      const el = document.querySelector(${JSON.stringify(selector)});
      if (el) {
        el.focus();
        el.select?.();
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
          || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
        if (nativeInputValueSetter) nativeInputValueSetter.call(el, '');
        else el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    `);
    await this.sleep(50);

    // Type new value
    await this.type(value, { delay: 40 });
  }

  // ── JS evaluation ─────────────────────────────────────────────────────────────

  async evaluate<T = unknown>(expression: string): Promise<T> {
    return this._eval<T>(expression);
  }

  // ── Screenshot ────────────────────────────────────────────────────────────────

  async screenshot(): Promise<string> {
    const { data } = await this.client.Page.captureScreenshot({ format: 'png' });
    return data;
  }

  // ── Utilities ─────────────────────────────────────────────────────────────────

  async sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private async _eval<T>(expression: string): Promise<T> {
    const result = await this.client.Runtime.evaluate({
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      const msg = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      throw new Error(`evaluate error: ${msg}`);
    }
    return result.result.value as T;
  }

  private async _boundingRect(selector: string): Promise<Rect | null> {
    return this._eval<Rect | null>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    })()`);
  }

  private async _mouseMove(x: number, y: number): Promise<void> {
    await this.client.Input.dispatchMouseEvent({
      type: 'mouseMoved',
      x,
      y,
      button: 'none',
      clickCount: 0,
    });
  }

  private async _mouseDown(x: number, y: number): Promise<void> {
    await this.client.Input.dispatchMouseEvent({
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
  }

  private async _mouseUp(x: number, y: number): Promise<void> {
    await this.client.Input.dispatchMouseEvent({
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
  }

  private _waitForLoad(timeout: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`waitForLoad timeout after ${timeout}ms`)),
        timeout,
      );
      this.client.Page.loadEventFired(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private _timeout(ms: number, label: string): Promise<never> {
    return new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout ${ms}ms exceeded: ${label}`)), ms),
    );
  }
}
