import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import type { ChromeSession, ScreencastFrame } from '@funny/core/chrome';
import { WebSocketServer, WebSocket } from 'ws';

import { VisualRegression } from './lib/visual-regression.ts';
import { ScriptRunner } from './script-runner.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface StreamingServerOptions {
  httpPort?: number;
  wsPort?: number;
}

interface ClientMessage {
  type:
    | 'navigate'
    | 'execute'
    | 'screenshot'
    | 'mouseEvent'
    | 'keyEvent'
    | 'scroll'
    | 'runScript'
    | 'stopScript';
  payload?: string;
  // mouse fields
  mouseType?: 'mouseMoved' | 'mousePressed' | 'mouseReleased' | 'mouseWheel';
  x?: number;
  y?: number;
  button?: 'none' | 'left' | 'middle' | 'right';
  clickCount?: number;
  deltaX?: number;
  deltaY?: number;
  modifiers?: number;
  // key fields
  keyType?: 'keyDown' | 'keyUp' | 'char';
  key?: string;
  code?: string;
  text?: string;
  windowsVirtualKeyCode?: number;
  // script fields
  script?: string;
  scriptCode?: string;
}

export class StreamingServer {
  private wss: WebSocketServer;
  private httpPort: number;
  private wsPort: number;
  private clients = new Set<WebSocket>();
  private session: ChromeSession | null = null;
  private framesSent = 0;
  private startTime = Date.now();
  private scriptRunner: ScriptRunner | null = null;

  constructor(options: StreamingServerOptions = {}) {
    this.httpPort = options.httpPort ?? 3500;
    this.wsPort = options.wsPort ?? 3501;

    this.wss = new WebSocketServer({ port: this.wsPort });
    this.setupWebSocket();
  }

  attachSession(session: ChromeSession): void {
    this.session = session;

    session.on('frame', (frame: ScreencastFrame) => {
      this.broadcastFrame(frame);
    });

    session.on('navigate', (url: string) => {
      this.broadcast({ type: 'navigate', url });
    });

    session.on('pageLoad', () => {
      this.broadcast({ type: 'pageLoad' });
    });

    session.on('disconnect', () => {
      this.broadcast({ type: 'chromeDisconnected' });
    });
  }

  private setupWebSocket(): void {
    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      console.log(`[StreamingServer] Client connected. Total: ${this.clients.size}`);

      // Send current stats on connect
      ws.send(
        JSON.stringify({
          type: 'stats',
          data: this.getStats(),
        }),
      );

      // Notify if a script is already running
      if (this.scriptRunner?.isRunning()) {
        ws.send(JSON.stringify({ type: 'scriptRunning' }));
      }

      ws.on('message', async (raw) => {
        try {
          const msg: ClientMessage = JSON.parse(raw.toString());
          await this.handleClientMessage(ws, msg);
        } catch (err) {
          ws.send(JSON.stringify({ type: 'error', message: String(err) }));
        }
      });

      ws.on('close', () => {
        this.clients.delete(ws);
        console.log(`[StreamingServer] Client disconnected. Total: ${this.clients.size}`);
      });

      ws.on('error', (err) => {
        console.error('[StreamingServer] WS error:', err.message);
        this.clients.delete(ws);
      });
    });

    console.log(`[StreamingServer] WebSocket listening on ws://0.0.0.0:${this.wsPort}`);
  }

  private async handleClientMessage(ws: WebSocket, msg: ClientMessage): Promise<void> {
    if (msg.type === 'runScript') {
      await this.handleRunScript(msg);
      return;
    }

    if (msg.type === 'stopScript') {
      this.scriptRunner?.stop();
      return;
    }

    if (!this.session) {
      ws.send(JSON.stringify({ type: 'error', message: 'No Chrome session' }));
      return;
    }

    if (msg.type === 'navigate' && msg.payload) {
      await this.session.navigate(msg.payload);
      ws.send(JSON.stringify({ type: 'ack', action: 'navigate', url: msg.payload }));
    } else if (msg.type === 'execute' && msg.payload) {
      const result = await this.session.execute(msg.payload);
      ws.send(JSON.stringify({ type: 'executeResult', result }));
    } else if (msg.type === 'screenshot') {
      const png = await this.session.screenshot();
      ws.send(JSON.stringify({ type: 'screenshot', data: png }));
    } else if (msg.type === 'mouseEvent' && msg.mouseType !== undefined) {
      await this.session.dispatchMouseEvent({
        type: msg.mouseType,
        x: msg.x ?? 0,
        y: msg.y ?? 0,
        button: msg.button ?? 'none',
        clickCount: msg.clickCount ?? 0,
        deltaX: msg.deltaX ?? 0,
        deltaY: msg.deltaY ?? 0,
        modifiers: msg.modifiers ?? 0,
      });
    } else if (msg.type === 'keyEvent' && msg.keyType && msg.key && msg.code) {
      await this.session.dispatchKeyEvent({
        type: msg.keyType,
        key: msg.key,
        code: msg.code,
        text: msg.text,
        modifiers: msg.modifiers ?? 0,
        windowsVirtualKeyCode: msg.windowsVirtualKeyCode,
      });
    } else if (msg.type === 'scroll') {
      await this.session.dispatchScroll(msg.x ?? 0, msg.y ?? 0, msg.deltaX ?? 0, msg.deltaY ?? 0);
    }
  }

  private async handleRunScript(msg: ClientMessage): Promise<void> {
    if (this.scriptRunner?.isRunning()) {
      this.broadcast({
        type: 'scriptLog',
        line: '⚠ A script is already running. Stop it first.',
        stream: 'stderr',
      });
      return;
    }

    const scriptName = msg.script ?? 'demo-search';
    console.log(`[StreamingServer] Running script: ${scriptName}`);

    this.scriptRunner = new ScriptRunner();

    this.scriptRunner.on('start', () => {
      this.broadcast({ type: 'scriptStart', script: scriptName });
      this.broadcast({ type: 'scriptLog', line: `▶ Running: ${scriptName}`, stream: 'stdout' });
    });

    this.scriptRunner.on('log', ({ line, stream }: { line: string; stream: string }) => {
      this.broadcast({ type: 'scriptLog', line, stream });
    });

    this.scriptRunner.on('done', ({ exitCode }: { exitCode: number }) => {
      this.broadcast({
        type: 'scriptLog',
        line: `✓ Script finished (exit ${exitCode})`,
        stream: 'stdout',
      });
      this.broadcast({ type: 'scriptDone', exitCode });
    });

    this.scriptRunner.on(
      'error',
      ({ exitCode, message }: { exitCode: number; message: string }) => {
        this.broadcast({ type: 'scriptLog', line: `✗ ${message}`, stream: 'stderr' });
        this.broadcast({ type: 'scriptError', exitCode, message });
      },
    );

    this.scriptRunner.on('stopped', () => {
      this.broadcast({ type: 'scriptLog', line: '⏹ Script stopped.', stream: 'stderr' });
      this.broadcast({ type: 'scriptStopped' });
    });

    // Run async — do not await so the WS handler returns immediately
    this.scriptRunner
      .run({
        script: scriptName,
        code: msg.scriptCode,
      })
      .catch((err: Error) => {
        this.broadcast({
          type: 'scriptLog',
          line: `✗ Failed to start: ${err.message}`,
          stream: 'stderr',
        });
        this.broadcast({ type: 'scriptError', exitCode: -1, message: err.message });
      });
  }

  private broadcastFrame(frame: ScreencastFrame): void {
    if (this.clients.size === 0) return;

    this.framesSent++;
    const msg = JSON.stringify({
      type: 'frame',
      data: frame.data,
      timestamp: frame.timestamp,
    });

    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    }
  }

  private broadcast(payload: object): void {
    const msg = JSON.stringify(payload);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    }
  }

  getStats() {
    return {
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      connectedClients: this.clients.size,
      framesSent: this.framesSent,
      chrome: this.session?.getStats() ?? null,
      scriptRunning: this.scriptRunner?.isRunning() ?? false,
    };
  }

  /** HTTP server: viewer HTML + stats + snapshot images */
  startHttpServer(): void {
    const viewerHtml = readFileSync(join(__dirname, 'viewer.html'), 'utf-8');

    Bun.serve({
      port: this.httpPort,
      fetch(req) {
        const url = new URL(req.url);

        if (url.pathname === '/' || url.pathname === '/index.html') {
          return new Response(viewerHtml, {
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          });
        }

        if (url.pathname === '/health') {
          return Response.json({ status: 'ok' });
        }

        // GET /snapshots — list suites
        if (url.pathname === '/snapshots' || url.pathname === '/snapshots/') {
          return Response.json({ suites: VisualRegression.listSuites() });
        }

        // GET /snapshots/:suite/report.json
        const reportMatch = url.pathname.match(/^\/snapshots\/([^/]+)\/report\.json$/);
        if (reportMatch) {
          const reportPath = join('/app/snapshots', reportMatch[1], 'report.json');
          if (existsSync(reportPath)) {
            return new Response(readFileSync(reportPath, 'utf-8'), {
              headers: { 'Content-Type': 'application/json' },
            });
          }
          return Response.json({ error: 'Report not found' }, { status: 404 });
        }

        // GET /snapshots/:suite/:type/:step.png  (type = baseline|actual|diff)
        const imgMatch = url.pathname.match(
          /^\/snapshots\/([^/]+)\/(baseline|actual|diff)\/([^/]+\.png)$/,
        );
        if (imgMatch) {
          const imgPath = join('/app/snapshots', imgMatch[1], imgMatch[2], imgMatch[3]);
          if (existsSync(imgPath)) {
            return new Response(readFileSync(imgPath), {
              headers: { 'Content-Type': 'image/png' },
            });
          }
          return new Response('Image not found', { status: 404 });
        }

        return new Response('Not Found', { status: 404 });
      },
    });

    console.log(`[StreamingServer] Viewer available at http://0.0.0.0:${this.httpPort}`);
  }

  async shutdown(): Promise<void> {
    this.scriptRunner?.stop();
    await new Promise<void>((resolve, reject) => {
      this.wss.close((err) => (err ? reject(err) : resolve()));
    });
  }
}
