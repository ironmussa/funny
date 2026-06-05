/**
 * PiACPProcess — adapter that wraps the `pi-acp` adapter
 * (https://github.com/svkozak/pi-acp) behind the IAgentProcess
 * EventEmitter interface, communicating via the Agent Client Protocol
 * (ACP) over stdio.
 *
 * Spawns `pi-acp` as a subprocess. `pi-acp` itself spawns `pi --mode rpc`
 * internally, so the user must have `pi` (@mariozechner/pi-coding-agent)
 * installed and configured with provider credentials separately. Funny
 * does not pass a `--model` flag — model/provider selection is owned by
 * pi's own settings (`~/.pi/agent/settings.json`).
 *
 * Translates ACP session updates into CLIMessage format so that
 * AgentMessageHandler works unchanged (same as GeminiACPProcess and
 * CodexACPProcess).
 *
 * The child process and ACP session are kept alive across turns: the
 * initial prompt is run inline from `runProcess()`, after which the run
 * loop awaits shutdown. Follow-up prompts are issued via `sendPrompt()`
 * which calls `connection.prompt()` on the same session — no respawn,
 * no history replay.
 */

import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { Readable, Writable } from 'stream';

import { createDebugLogger } from '../debug.js';
import { toACPImageBlocks, type ACPImageBlock } from './acp-image.js';
import { toACPMcpServers } from './acp-mcp.js';
import { inferACPToolName, buildACPToolInput, extractACPToolOutput } from './acp-tool-input.js';
import { BaseAgentProcess, type ResultSubtype } from './base-process.js';
import type { CLIMessage } from './types.js';

const dlog = createDebugLogger('acp-pi');

// Lazy-loaded SDK types (avoid crash if not installed)
type ACPSDK = typeof import('@agentclientprotocol/sdk');
type ACPClient = import('@agentclientprotocol/sdk').Client;
type ACPAgent = import('@agentclientprotocol/sdk').Agent;
type ACPSessionNotification = import('@agentclientprotocol/sdk').SessionNotification;
type ACPSessionUpdate = import('@agentclientprotocol/sdk').SessionUpdate;
type ACPRequestPermissionRequest = import('@agentclientprotocol/sdk').RequestPermissionRequest;
type ACPRequestPermissionResponse = import('@agentclientprotocol/sdk').RequestPermissionResponse;
type ACPConnection = import('@agentclientprotocol/sdk').ClientSideConnection;

/** Pi built-in tools surfaced via system:init. Matches `pi --tools` defaults. */
const PI_BUILTIN_TOOLS = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'];

/**
 * Pi prepends a banner to its first agent_message_chunk, e.g.
 *   pi v0.70.2
 *   ---
 *
 *   ## Skills
 *   - /path/to/SKILL.md
 *   ...
 *
 * Strip the leading version line, the `---` separator, and any subsequent
 * `## Section` blocks (with their bullet lists) before the actual response.
 */
function stripPiBanner(text: string): string {
  const banner = /^pi v[\d.]+\s*\n-{3,}\s*\n+(?:##[^\n]*\n(?:[-*][^\n]*\n)*\n*)*/;
  return text.replace(banner, '').replace(/^\s+/, '');
}

export class PiACPProcess extends BaseAgentProcess {
  private childProcess: ChildProcess | null = null;

  // ── Long-lived per-process state ─────────────────────────────────
  private connection: ACPConnection | null = null;
  private activeSessionId: string | null = null;
  private numTurns = 0;
  private totalCost = 0;
  /** True if the agent advertises `promptCapabilities.image` at init. */
  private supportsImages = false;

  // ── Per-turn state (reset on each runOnePrompt) ──────────────────
  private assistantMsgId: string = randomUUID();
  private accumulatedText = '';
  private toolCallsSeen = new Map<string, string>();
  private lastAssistantText = '';
  /** Buffer for `agent_thought_chunk` text — collapsed into a single Think tool call. */
  private pendingThought: { id: string; text: string } | null = null;

  /**
   * True while loadSession is replaying historical session updates.
   * funny's DB already holds the persisted history and we don't want
   * duplicates, so the sessionUpdate handler drops events while this is set.
   */
  private replayingHistory = false;

  private flushPendingThought(): void {
    if (!this.pendingThought) return;
    const { id, text } = this.pendingThought;
    this.pendingThought = null;
    if (!text.trim()) return;

    this.emit('message', {
      type: 'assistant',
      message: {
        id: randomUUID(),
        content: [{ type: 'tool_use', id, name: 'Think', input: { content: text } }],
      },
    } as CLIMessage);

    this.emit('message', {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: id, content: text }],
      },
    } as CLIMessage);
  }

  // ── Overrides ──────────────────────────────────────────────────

  async kill(): Promise<void> {
    await super.kill();
    if (this.childProcess && !this.childProcess.killed) {
      this.childProcess.kill('SIGTERM');
    }
  }

  /** Multi-turn: re-prompt on the live ACP session. */
  async sendPrompt(prompt: string, images?: unknown[]): Promise<void> {
    return this.enqueuePrompt(prompt, images);
  }

  /** Expose the live ACP session so BaseAgentProcess.steerPrompt can cancel it. */
  protected getCancellableSession() {
    if (!this.connection || !this.activeSessionId) return null;
    const sessionId = this.activeSessionId;
    const conn = this.connection;
    return {
      sessionId,
      cancel: async () => {
        await conn.cancel({ sessionId });
      },
    };
  }

  // ── Provider-specific run loop ─────────────────────────────────

  protected async runProcess(): Promise<void> {
    let SDK: ACPSDK;
    try {
      SDK = await import('@agentclientprotocol/sdk');
    } catch {
      throw new Error(
        'ACP SDK not installed. Run: bun add @agentclientprotocol/sdk\n' +
          'Also ensure pi-acp is available: npm install -g pi-acp ' +
          '(or rely on `npx -y pi-acp`). Pi itself must also be installed: ' +
          'npm install -g @mariozechner/pi-coding-agent',
      );
    }

    const { ClientSideConnection, ndJsonStream } = SDK;

    const { command, args } = this.resolvePiAcpCommand();
    dlog.info('spawning pi-acp', { command, args, cwd: this.options.cwd });

    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      signal: this.abortController.signal,
      shell: process.platform === 'win32',
    });

    this.childProcess = child;

    child.on('error', (err: any) => {
      if (!this._exited && !this.isAborted) {
        if (err.code === 'ENOENT') {
          this.emit(
            'error',
            new Error(
              "'pi-acp' binary not found in PATH or failed to spawn.\n" +
                'Install via: npm install -g pi-acp\n' +
                'Also install pi: npm install -g @mariozechner/pi-coding-agent\n' +
                'Or set PI_ACP_BINARY_PATH to a custom location.\n' +
                'See https://github.com/svkozak/pi-acp for details.',
            ),
          );
        } else {
          this.emit('error', err);
        }
      }
    });

    // If the child exits unexpectedly (crash, OOM, parent kill), shut down
    // the run loop so awaitShutdown() resolves and finalize() runs. Without
    // this, a long-lived adapter would leak its run loop after a child crash.
    child.on('exit', (code, signal) => {
      if (!this.isAborted && !this._exited) {
        dlog.warn('pi-acp child exited unexpectedly', { code, signal });
        this.abortController.abort();
      }
    });

    child.stderr?.on('data', (data: Buffer) => {
      const raw = data.toString().trim();
      if (!raw) return;
      const errorText = this.parseStderrError(raw);
      if (errorText) this.emitErrorToolCall(errorText);
    });

    try {
      await new Promise<void>((resolve, reject) => {
        child.on('spawn', resolve);
        child.on('error', reject);
      });
    } catch {
      this._exited = true;
      return;
    }

    const outputStream = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>;
    const inputStream = Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>;
    const stream = ndJsonStream(outputStream, inputStream);

    const acpClient: ACPClient = {
      sessionUpdate: async (params: ACPSessionNotification): Promise<void> => {
        if (this.isAborted) return;
        const update = params.update;
        if (this.replayingHistory && update.sessionUpdate !== 'usage_update') return;
        this.translateUpdate(update);
      },

      requestPermission: async (
        params: ACPRequestPermissionRequest,
      ): Promise<ACPRequestPermissionResponse> => {
        const allowOption = params.options.find(
          (opt) => opt.kind === 'allow_once' || opt.kind === 'allow_always',
        );
        if (allowOption) {
          return {
            outcome: { outcome: 'selected', optionId: allowOption.optionId },
          };
        }
        return {
          outcome: { outcome: 'selected', optionId: params.options[0]?.optionId ?? '' },
        };
      },
    };

    const connection = new ClientSideConnection((_agent: ACPAgent) => acpClient, stream);
    this.connection = connection;

    try {
      const initResult = await connection.initialize({
        protocolVersion: 1,
        clientInfo: { name: 'funny', version: '1.0.0' },
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      });

      const supportsLoadSession = initResult.agentCapabilities?.loadSession === true;
      this.supportsImages = initResult.agentCapabilities?.promptCapabilities?.image === true;
      const mcpCaps = (initResult.agentCapabilities as Record<string, any> | undefined)
        ?.mcpCapabilities;
      const supportsHttp = mcpCaps?.http === true;
      const supportsSse = mcpCaps?.sse === true;

      // Resume existing session if possible, else create a new one.
      // Filter MCP servers by what the agent advertises it supports — pi-acp
      // declares `mcpCapabilities: { http: false, sse: false }` and currently
      // never consumes the list at all, so passing HTTP/SSE entries causes
      // pi-acp to fail. Stdio is mandatory per ACP spec and always allowed.
      const allMcp = toACPMcpServers(this.options.mcpServers);
      const mcpServerList = allMcp.filter((s) => {
        const t = s.type as string | undefined;
        if (t === 'http') return supportsHttp;
        if (t === 'sse') return supportsSse;
        return true;
      });
      if (allMcp.length !== mcpServerList.length) {
        dlog.warn('dropped MCP servers unsupported by agent', {
          dropped: allMcp.length - mcpServerList.length,
          mcpCapabilities: mcpCaps,
        });
      }

      let sessionResponse: Awaited<ReturnType<typeof connection.newSession>> | null = null;
      if (this.options.sessionId && supportsLoadSession) {
        this.activeSessionId = this.options.sessionId;
        this.replayingHistory = true;
        try {
          await connection.loadSession({
            sessionId: this.options.sessionId,
            cwd: this.options.cwd,
            mcpServers: mcpServerList,
          });
        } finally {
          this.replayingHistory = false;
        }
      } else {
        sessionResponse = await connection.newSession({
          cwd: this.options.cwd,
          mcpServers: mcpServerList,
        });
        this.activeSessionId = sessionResponse.sessionId;
      }

      // Emit init with the real session id once known so the persisted
      // record matches what pi-acp wrote to its session store.
      this.emitInit(
        this.activeSessionId,
        PI_BUILTIN_TOOLS,
        this.options.model ?? 'pi-default',
        this.options.cwd,
      );

      const sessionModels = (sessionResponse as any)?.models;
      if (sessionModels) {
        dlog.info('session/new advertised models', {
          availableModels: JSON.stringify(sessionModels.availableModels),
          currentModelId: sessionModels.currentModelId,
        });
      }

      // Select the requested model via ACP if one was specified and it's not
      // the sentinel `default` (which means "use pi's configured default").
      const requestedModel = this.options.model;
      if (requestedModel && requestedModel !== 'default') {
        try {
          await (connection as any).unstable_setSessionModel({
            sessionId: this.activeSessionId,
            modelId: requestedModel,
          });
          dlog.info('session/set_model applied', { modelId: requestedModel });
        } catch (e) {
          dlog.warn('session/set_model failed — falling back to pi default', {
            modelId: requestedModel,
            error: (e as Error)?.message,
          });
        }
      }

      // Run the initial prompt inline so any setup error surfaces as a
      // failed first turn rather than a stuck "no response" thread.
      await this.runOnePrompt(this.options.prompt, this.options.images);

      // Stay alive across turns — sendPrompt() will issue follow-up prompts
      // on the same connection. Resolves when kill() is called.
      await this.awaitShutdown();
    } catch (err: unknown) {
      this.flushPendingThought();
      if (!this.isAborted) {
        const errorMessage = this.extractErrorMessage(err);
        this.emitResult({
          sessionId: this.activeSessionId ?? randomUUID(),
          subtype: 'error_during_execution',
          startTime: Date.now(),
          numTurns: this.numTurns,
          totalCost: this.totalCost,
          result: errorMessage,
          errors: [errorMessage],
        });
      }
    } finally {
      if (this.childProcess && !this.childProcess.killed) {
        this.childProcess.kill('SIGTERM');
      }
      this.connection = null;
      this.finalize();
    }
  }

  // ── Per-turn execution ──────────────────────────────────────────

  protected async runOnePrompt(prompt: string, images?: unknown[]): Promise<void> {
    if (!this.connection || !this.activeSessionId) {
      throw new Error('PiACPProcess: connection not initialized');
    }

    // Reset per-turn state so each turn renders as a fresh assistant message.
    this.assistantMsgId = randomUUID();
    this.accumulatedText = '';
    this.toolCallsSeen.clear();
    this.lastAssistantText = '';
    this.pendingThought = null;

    const startTime = Date.now();

    // Forward images for this turn only if the agent advertised image support
    // — otherwise pi-acp would reject the prompt or silently drop the blocks.
    const promptBlocks: Array<{ type: 'text'; text: string } | ACPImageBlock> = [
      { type: 'text', text: prompt },
    ];
    const imageBlocks = toACPImageBlocks(images);
    dlog.info('runOnePrompt image diagnostics', {
      rawImagesType: Array.isArray(images) ? 'array' : typeof images,
      rawImagesCount: Array.isArray(images) ? images.length : 0,
      acpBlockCount: imageBlocks.length,
      supportsImages: this.supportsImages,
    });
    if (imageBlocks.length > 0) {
      if (this.supportsImages) {
        promptBlocks.push(...imageBlocks);
      } else {
        dlog.warn('agent does not advertise promptCapabilities.image — dropping images', {
          count: imageBlocks.length,
        });
      }
    }

    try {
      const promptResponse = await this.connection.prompt({
        sessionId: this.activeSessionId,
        prompt: promptBlocks,
      });

      this.emitAcpPromptResponseUsage(promptResponse.usage);

      this.numTurns += 1;

      const subtype: ResultSubtype =
        promptResponse.stopReason === 'end_turn'
          ? 'success'
          : promptResponse.stopReason === 'cancelled'
            ? 'error_during_execution'
            : promptResponse.stopReason === 'max_tokens'
              ? 'error_max_turns'
              : 'success';

      this.flushPendingThought();

      this.emitResult({
        sessionId: this.activeSessionId,
        subtype,
        startTime,
        numTurns: this.numTurns,
        totalCost: this.totalCost,
        result: this.lastAssistantText || undefined,
      });
    } catch (err: unknown) {
      this.flushPendingThought();
      if (!this.isAborted) {
        const errorMessage = this.extractErrorMessage(err);
        this.emitResult({
          sessionId: this.activeSessionId,
          subtype: 'error_during_execution',
          startTime,
          numTurns: this.numTurns,
          totalCost: this.totalCost,
          result: errorMessage,
          errors: [errorMessage],
        });
      }
    }
  }

  // ── Update translation ──────────────────────────────────────

  private translateUpdate(update: ACPSessionUpdate): void {
    if (this.handleAcpUsageUpdate(update)) return;

    switch (update.sessionUpdate) {
      case 'agent_thought_chunk': {
        const content = update.content;
        if (content.type === 'text' && content.text) {
          if (!this.pendingThought) {
            this.pendingThought = { id: randomUUID(), text: '' };
          }
          this.pendingThought.text += content.text;
        }
        return;
      }

      case 'agent_message_chunk': {
        this.flushPendingThought();
        const content = update.content;
        if (content.type === 'text' && content.text) {
          this.accumulatedText += content.text;
          const visible = stripPiBanner(this.accumulatedText);
          if (visible) {
            this.emit('message', {
              type: 'assistant',
              message: {
                id: this.assistantMsgId,
                content: [{ type: 'text', text: visible }],
              },
            } as CLIMessage);
            this.lastAssistantText = visible;
          }
        }
        return;
      }

      case 'tool_call': {
        this.flushPendingThought();
        const toolCallId = update.toolCallId;
        if (this.toolCallsSeen.has(toolCallId)) return;

        const acpKind = (update as any).kind as string | undefined;
        const title = update.title || '';
        const locations = (update as any).locations as
          | Array<{ path: string; line?: number | null }>
          | undefined;
        const toolName = inferACPToolName(acpKind, title);
        this.toolCallsSeen.set(toolCallId, toolName);

        const input = buildACPToolInput(toolName, {
          kind: acpKind,
          title,
          rawInput: update.rawInput,
          locations,
        });

        this.emit('message', {
          type: 'assistant',
          message: {
            id: randomUUID(),
            content: [{ type: 'tool_use', id: toolCallId, name: toolName, input }],
          },
        } as CLIMessage);

        const tcStatus = (update as any).status as string | undefined;
        if (tcStatus === 'completed' || tcStatus === 'failed') {
          this.toolCallsSeen.set(toolCallId, 'done');
          const tcOutput = extractACPToolOutput(update.rawOutput, (update as any).content, title);
          this.emit('message', {
            type: 'user',
            message: {
              content: [{ type: 'tool_result', tool_use_id: toolCallId, content: tcOutput }],
            },
          } as CLIMessage);
        }

        // Rotate assistant message id so post-tool-call text becomes a
        // separate DB message from any pre-tool-call streaming text.
        this.accumulatedText = '';
        this.assistantMsgId = randomUUID();
        return;
      }

      case 'tool_call_update': {
        this.flushPendingThought();
        const toolCallId = update.toolCallId;
        if (update.status === 'completed' || update.status === 'failed') {
          this.toolCallsSeen.set(toolCallId, 'done');
          const output = extractACPToolOutput(
            update.rawOutput,
            (update as any).content,
            update.title || '',
          );
          this.emit('message', {
            type: 'user',
            message: {
              content: [{ type: 'tool_result', tool_use_id: toolCallId, content: output }],
            },
          } as CLIMessage);
        }
        return;
      }

      case 'plan': {
        this.flushPendingThought();
        const entries = update.entries ?? [];
        if (entries.length > 0) {
          const planText = entries
            .map((e: any, i: number) => {
              const status =
                e.status === 'completed' ? '[x]' : e.status === 'in_progress' ? '[~]' : '[ ]';
              return `${status} ${i + 1}. ${e.title ?? e.description ?? 'Task'}`;
            })
            .join('\n');

          this.emit('message', {
            type: 'assistant',
            message: {
              id: this.assistantMsgId,
              content: [{ type: 'text', text: `**Plan:**\n${planText}` }],
            },
          } as CLIMessage);
        }
        return;
      }

      default:
        return;
    }
  }

  // ── Binary resolution ───────────────────────────────────────

  private resolvePiAcpCommand(): { command: string; args: string[] } {
    const explicit = process.env.PI_ACP_BINARY_PATH || process.env.ACP_PI_BIN;
    if (explicit) return { command: explicit, args: [] };

    if (process.env.PI_ACP_USE_NPX === '1') {
      return { command: 'npx', args: ['-y', 'pi-acp'] };
    }

    return { command: 'pi-acp', args: [] };
  }
}
