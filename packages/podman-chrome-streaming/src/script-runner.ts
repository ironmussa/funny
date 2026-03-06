import { EventEmitter } from 'events';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export type ScriptLogStream = 'stdout' | 'stderr';

export interface ScriptLogEvent {
  line: string;
  stream: ScriptLogStream;
}

export interface ScriptRunnerOptions {
  /** Name of a predefined script (without .ts) or "custom" */
  script: string;
  /** TypeScript source code — only used when script === "custom" */
  code?: string;
  /** CDP endpoint for Playwright to connect to */
  cdpUrl?: string;
}

const PREDEFINED_SCRIPTS_DIR = join(__dirname, 'scripts');
const CUSTOM_SCRIPT_PATH = '/tmp/custom-playwright-script.ts';

export class ScriptRunner extends EventEmitter {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private running = false;

  async run(options: ScriptRunnerOptions): Promise<void> {
    if (this.running) throw new Error('A script is already running');

    const scriptPath = this.resolveScript(options);
    const cdpUrl = options.cdpUrl ?? 'http://localhost:9222';

    this.running = true;
    this.emit('start', { script: options.script });

    this.proc = Bun.spawn(['bun', 'run', scriptPath], {
      env: {
        ...process.env,
        CDP_URL: cdpUrl,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const proc = this.proc;
    const stdout = proc.stdout as ReadableStream<Uint8Array> | null;
    const stderr = proc.stderr as ReadableStream<Uint8Array> | null;

    // Stream stdout and stderr concurrently
    await Promise.all([this.pipeStream(stdout, 'stdout'), this.pipeStream(stderr, 'stderr')]);

    const exitCode = await proc.exited;
    this.running = false;
    if (this.proc === proc) {
      this.proc = null;
    }

    if (exitCode === 0) {
      this.emit('done', { exitCode });
    } else {
      this.emit('error', { exitCode, message: `Script exited with code ${exitCode}` });
    }
  }

  stop(): void {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
      this.running = false;
      this.emit('stopped');
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  private resolveScript(options: ScriptRunnerOptions): string {
    if (options.script === 'custom') {
      if (!options.code) throw new Error('Custom script requires code');
      // Prepend CDP_URL helper so scripts can use it without importing
      const header = `const CDP_URL = process.env.CDP_URL ?? "http://localhost:9222";\n`;
      writeFileSync(CUSTOM_SCRIPT_PATH, header + options.code, 'utf-8');
      return CUSTOM_SCRIPT_PATH;
    }
    return join(PREDEFINED_SCRIPTS_DIR, `${options.script}.ts`);
  }

  private async pipeStream(
    stream: ReadableStream<Uint8Array> | null,
    type: ScriptLogStream,
  ): Promise<void> {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.trim()) {
          this.emit('log', { line, stream: type } satisfies ScriptLogEvent);
        }
      }
    }

    // Flush any remaining buffer
    if (buffer.trim()) {
      this.emit('log', { line: buffer, stream: type } satisfies ScriptLogEvent);
    }
  }
}
