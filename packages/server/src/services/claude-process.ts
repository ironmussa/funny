/**
 * ClaudeProcess — spawns and manages a single claude CLI process.
 * Communicates via NDJSON over stdin/stdout.
 * Uses Bun.spawn for process management.
 */

import { EventEmitter } from 'events';
import { LineBuffer, decodeNDJSON } from '../utils/ndjson-transport.js';
import { getClaudeBinaryPath } from '../utils/claude-binary.js';

// ── CLI Message Types ──────────────────────────────────────────────

export interface CLISystemMessage {
  type: 'system';
  subtype: 'init';
  session_id: string;
  tools?: string[];
  model?: string;
  cwd?: string;
}

export interface CLIAssistantMessage {
  type: 'assistant';
  message: {
    content: Array<
      | { type: 'text'; text: string }
      | { type: 'tool_use'; id: string; name: string; input: unknown }
    >;
    usage?: { input_tokens: number; output_tokens: number };
  };
  parent_tool_use_id?: string | null;
}

export interface CLIUserMessage {
  type: 'user';
  message: {
    content: Array<{
      type: 'tool_result';
      tool_use_id: string;
      content: string;
    }>;
  };
}

export interface CLIResultMessage {
  type: 'result';
  subtype:
    | 'success'
    | 'error_max_turns'
    | 'error_during_execution'
    | 'error_max_budget_usd';
  is_error: boolean;
  duration_ms: number;
  num_turns: number;
  result?: string;
  total_cost_usd: number;
  session_id: string;
  errors?: string[];
}

export type CLIMessage =
  | CLISystemMessage
  | CLIAssistantMessage
  | CLIUserMessage
  | CLIResultMessage;

// ── Process Options ────────────────────────────────────────────────

export interface ClaudeProcessOptions {
  prompt: string;
  cwd: string;
  model?: string;
  allowedTools?: string[];
  maxTurns?: number;
  sessionId?: string;
  permissionMode?: string;
  images?: any[];
}

// ── ClaudeProcess Class ────────────────────────────────────────────

const WATCHDOG_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const KILL_GRACE_MS = 3_000;

export class ClaudeProcess extends EventEmitter {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private lineBuffer = new LineBuffer();
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private stderrBuf = '';
  private _exited = false;

  constructor(private options: ClaudeProcessOptions) {
    super();
  }

  start(): void {
    const binaryPath = getClaudeBinaryPath();
    const args = this.buildArgs();

    console.log(`[claude-process] Binary: ${binaryPath}`);
    console.log(`[claude-process] Args: ${JSON.stringify(args)}`);
    console.log(`[claude-process] CWD: ${this.options.cwd}`);

    this.proc = Bun.spawn([binaryPath, ...args], {
      cwd: this.options.cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: this.options.images && this.options.images.length > 0 ? 'pipe' : null,
    });

    console.log(`[claude-process] Spawned PID: ${this.proc.pid}`);

    // If we have images, send the structured message via stdin
    if (this.options.images && this.options.images.length > 0 && this.proc.stdin) {
      this.sendInitialMessage();
    }

    // Start reading stdout and stderr in background (non-blocking)
    this.readStdout();
    this.readStderr();

    // Handle process exit
    this.proc.exited
      .then((exitCode) => {
        console.log(`[claude-process] Process exited with code: ${exitCode}`);
        this._exited = true;
        this.clearWatchdog();

        // Flush any remaining buffered data
        const remaining = this.lineBuffer.flush();
        if (remaining) {
          try {
            const msg = decodeNDJSON(remaining) as CLIMessage;
            this.emit('message', msg);
          } catch {
            // Ignore incomplete trailing data
          }
        }

        if (exitCode !== 0 && exitCode !== null) {
          this.emit(
            'error',
            new Error(
              `claude process exited with code ${exitCode}. stderr: ${this.stderrBuf}`
            )
          );
        }
        this.emit('exit', exitCode, null);
      })
      .catch((err) => {
        this._exited = true;
        this.clearWatchdog();
        this.emit('error', err);
        this.emit('exit', null, null);
      });

    this.resetWatchdog();
  }

  private async readStdout(): Promise<void> {
    if (!this.proc?.stdout) return;
    const reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        this.resetWatchdog();
        const chunk = decoder.decode(value, { stream: true });
        console.log(`[claude-process:stdout] Raw chunk (${chunk.length} chars): ${chunk}`);
        const lines = this.lineBuffer.push(chunk);
        console.log(`[claude-process:stdout] Parsed ${lines.length} complete line(s)`);
        for (const line of lines) {
          try {
            const msg = decodeNDJSON(line) as CLIMessage;
            console.log(`[claude-process:msg] type=${msg.type}${('subtype' in msg && msg.subtype) ? ` subtype=${msg.subtype}` : ''}`);
            this.emit('message', msg);
          } catch {
            console.warn('[claude-process] Failed to parse NDJSON line:', line);
          }
        }
      }
    } catch (err) {
      // Stream error — process likely killed or crashed
      if (!this._exited) {
        console.error('[claude-process] stdout read error:', err);
      }
    }
  }

  private async readStderr(): Promise<void> {
    if (!this.proc?.stderr) return;
    const reader = (this.proc.stderr as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        console.error('[claude-process:stderr]', chunk.trimEnd());
        this.stderrBuf += chunk;
      }
    } catch {
      // Ignore stderr read errors
    }
  }

  /**
   * Build CLI arguments for the claude command.
   */
  private buildArgs(): string[] {
    const args: string[] = [
      '--print',
      '--output-format', 'stream-json',
      '--verbose',
    ];

    if (this.options.model) {
      args.push('--model', this.options.model);
    }

    if (this.options.permissionMode) {
      args.push('--permission-mode', this.options.permissionMode);
    }

    if (this.options.maxTurns) {
      args.push('--max-turns', String(this.options.maxTurns));
    }

    if (this.options.sessionId) {
      args.push('--resume', this.options.sessionId);
    }

    // allowedTools: comma-separated list of tools to auto-approve
    if (this.options.allowedTools && this.options.allowedTools.length > 0) {
      args.push('--allowedTools', this.options.allowedTools.join(','));
    }

    // If images are provided, use stream-json input format
    if (this.options.images && this.options.images.length > 0) {
      args.push('--input-format', 'stream-json');
      // Don't add the prompt as a positional arg - it will be sent via stdin
    } else {
      // '--' signals end of flags; prompt follows as positional arg
      args.push('--', this.options.prompt);
    }

    return args;
  }

  /**
   * Send the initial message with images via stdin using stream-json format
   */
  private async sendInitialMessage(): Promise<void> {
    if (!this.proc?.stdin || !this.options.images) return;

    try {
      const writer = (this.proc.stdin as unknown as WritableStream<Uint8Array>).getWriter();
      const encoder = new TextEncoder();

      // Build message content with text and images
      const content: any[] = [];

      // Always include text first, even if empty (use placeholder if needed)
      const promptText = this.options.prompt.trim() || 'What do you see in this image?';
      content.push({ type: 'text', text: promptText });

      // Add images
      content.push(...this.options.images);

      // Send as NDJSON message
      const message = {
        type: 'user',
        message: {
          content,
        },
      };

      const line = JSON.stringify(message) + '\n';
      console.log(`[claude-process] Sending initial message with ${this.options.images.length} images`);
      console.log(`[claude-process] Prompt text: "${promptText}"`);
      console.log(`[claude-process] First image preview:`, this.options.images[0]?.source?.media_type, `(${this.options.images[0]?.source?.data?.length || 0} chars)`);
      await writer.write(encoder.encode(line));
      await writer.close();
      console.log(`[claude-process] Message sent and stdin closed`);
    } catch (err) {
      console.error('[claude-process] Failed to send initial message:', err);
      this.emit('error', err);
    }
  }

  /**
   * Kill the process gracefully, then force after timeout.
   */
  async kill(): Promise<void> {
    if (!this.proc || this._exited) return;

    this.proc.kill(); // SIGTERM by default

    await Promise.race([
      this.proc.exited,
      new Promise<void>((resolve) =>
        setTimeout(() => {
          if (!this._exited && this.proc) {
            this.proc.kill(9); // SIGKILL
          }
          resolve();
        }, KILL_GRACE_MS)
      ),
    ]);
  }

  get exited(): boolean {
    return this._exited;
  }

  private resetWatchdog(): void {
    this.clearWatchdog();
    this.watchdogTimer = setTimeout(() => {
      console.error(
        '[claude-process] Watchdog timeout — no messages for 10 minutes'
      );
      this.kill();
    }, WATCHDOG_TIMEOUT_MS);
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }
}
