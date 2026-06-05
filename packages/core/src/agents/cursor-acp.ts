/**
 * CursorACPProcess — adapter that wraps the Cursor CLI behind the
 * IAgentProcess EventEmitter interface, communicating via the Agent Client
 * Protocol (ACP) over stdio.
 *
 * Spawns `cursor-agent acp` as a subprocess and translates ACP session
 * updates into CLIMessage format so that AgentMessageHandler works unchanged
 * (same pattern as GeminiACPProcess and PiACPProcess).
 *
 * Authentication: the user must either run `cursor-agent login` once on the
 * runner host, or set `CURSOR_API_KEY` in their funny provider keys (which
 * the runtime injects as an env var when spawning agent subprocesses).
 *
 * Model selection: cursor's catalog is discovered at runtime via
 * `cursor-discover.ts` and persisted as `provider:model` keys on the client.
 * On `runProcess` we call `unstable_setSessionModel(modelId)` if a non-default
 * model is requested; the model id flows through unchanged from the registry
 * (`resolveModelId('cursor', …)` passes pi-style).
 *
 * Permissions: mirrors `gemini-acp.ts` — checks funny's persisted permission
 * rules first, then if no rule matches, surfaces a synthetic tool_use +
 * tool_result so the PermissionApprovalCard renders. Under `autoEdit` mode
 * (funny's full-bypass) the handler short-circuits to allow_always without
 * consulting rules, matching the bypass semantics of other providers.
 *
 * The child process and ACP session are kept alive across turns: the initial
 * prompt is run inline from `runProcess()`, after which the run loop awaits
 * shutdown. Follow-up prompts are issued via `sendPrompt()` which calls
 * `connection.prompt()` on the same session — no respawn, no history replay.
 */

import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { Readable, Writable } from 'stream';

import { createDebugLogger } from '../debug.js';
import { toACPImageBlocks, type ACPImageBlock } from './acp-image.js';
import { toACPMcpServers } from './acp-mcp.js';
import {
  inferACPToolName,
  buildACPToolInput,
  buildTodoWriteInputFromPlanEntries,
  buildTodoWriteInputFromRaw,
  enrichTodoWriteInputFromOutput,
  extractACPToolOutput,
  hasRenderableTodoInput,
} from './acp-tool-input.js';
import { BaseAgentProcess, type ResultSubtype } from './base-process.js';
import type { CLIMessage } from './types.js';

const dlog = createDebugLogger('acp-cursor');

// Lazy-loaded SDK types (avoid crash if not installed)
type ACPSDK = typeof import('@agentclientprotocol/sdk');
type ACPClient = import('@agentclientprotocol/sdk').Client;
type ACPAgent = import('@agentclientprotocol/sdk').Agent;
type ACPSessionNotification = import('@agentclientprotocol/sdk').SessionNotification;
type ACPSessionUpdate = import('@agentclientprotocol/sdk').SessionUpdate;
type ACPRequestPermissionRequest = import('@agentclientprotocol/sdk').RequestPermissionRequest;
type ACPRequestPermissionResponse = import('@agentclientprotocol/sdk').RequestPermissionResponse;
type ACPConnection = import('@agentclientprotocol/sdk').ClientSideConnection;

/**
 * Cursor CLI built-in tools surfaced via system:init. ACP doesn't expose a
 * listTools API, so this list is best-effort based on Cursor's public docs.
 * It only drives the tool-name column on the init card — runtime tool calls
 * are translated by `inferACPToolName` regardless of whether they appear here.
 */
const CURSOR_BUILTIN_TOOLS = [
  'read_file',
  'write_file',
  'edit_file',
  'list_dir',
  'glob_file_search',
  'grep_search',
  'run_terminal_cmd',
  'web_search',
  'fetch_url',
  'todo_write',
];

export class CursorACPProcess extends BaseAgentProcess {
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
   * Tool calls whose initial event lacked the field its card needs to render
   * (e.g. a `read` whose path only arrives in a later `tool_call_update`).
   * Buffered here and emitted once an update carries the missing field, or at
   * terminal status. The server freezes a tool's input at first emission, so
   * emitting too early would permanently strand an empty card.
   */
  private deferredToolInputs = new Map<string, { name: string; input: Record<string, unknown> }>();

  /** True while loadSession is replaying historical events. */
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
          'Also ensure cursor-agent is installed: curl https://cursor.com/install -fsS | bash\n' +
          'See https://cursor.com/docs/cli/acp for details.',
      );
    }

    const { ClientSideConnection, ndJsonStream } = SDK;

    const { command, args } = this.resolveCursorAcpCommand();
    dlog.info('spawning cursor-agent acp', { command, args, cwd: this.options.cwd });

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
              "'cursor-agent' binary not found in PATH or failed to spawn.\n" +
                'Install via: curl https://cursor.com/install -fsS | bash\n' +
                'Or set CURSOR_BINARY_PATH to a custom location.\n' +
                'See https://cursor.com/docs/cli/acp for details.',
            ),
          );
        } else {
          this.emit('error', err);
        }
      }
    });

    // If the child exits unexpectedly, wake the run loop so cleanup happens.
    child.on('exit', (code, signal) => {
      if (!this.isAborted && !this._exited) {
        dlog.warn('cursor-agent child exited unexpectedly', { code, signal });
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
        // History replay streams old message/tool chunks we must not re-ingest,
        // but usage_update carries the live context window size we still want.
        if (this.replayingHistory && update.sessionUpdate !== 'usage_update') return;
        this.translateUpdate(update);
      },

      requestPermission: async (
        params: ACPRequestPermissionRequest,
      ): Promise<ACPRequestPermissionResponse> => {
        return this.handleRequestPermission(params);
      },
    };

    const connection = new ClientSideConnection((_agent: ACPAgent) => acpClient, stream);
    this.connection = connection;

    let sessionResponse: Awaited<ReturnType<typeof connection.newSession>> | null = null;

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

      this.emitInit(
        this.activeSessionId,
        CURSOR_BUILTIN_TOOLS,
        this.options.model ?? 'default',
        this.options.cwd,
      );

      const sessionModels = (sessionResponse as any)?.models;
      if (sessionModels) {
        dlog.info('session/new advertised models', {
          availableModels: JSON.stringify(sessionModels.availableModels),
          currentModelId: sessionModels.currentModelId,
        });
      }

      // Select the requested model via ACP if specified and not the sentinel
      // `default` (which means "use cursor's configured default").
      const requestedModel = this.options.model;
      if (requestedModel && requestedModel !== 'default') {
        try {
          await (connection as any).unstable_setSessionModel({
            sessionId: this.activeSessionId,
            modelId: requestedModel,
          });
          dlog.info('session/set_model applied', { modelId: requestedModel });
        } catch (e) {
          dlog.warn('session/set_model failed — falling back to cursor default', {
            modelId: requestedModel,
            error: (e as Error)?.message,
          });
        }
      }

      // Run initial prompt inline so a setup error surfaces as a failed turn.
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
      throw new Error('CursorACPProcess: connection not initialized');
    }

    // Reset per-turn state.
    this.assistantMsgId = randomUUID();
    this.accumulatedText = '';
    this.toolCallsSeen.clear();
    this.deferredToolInputs.clear();
    this.lastAssistantText = '';
    this.pendingThought = null;

    const startTime = Date.now();

    const promptBlocks: Array<{ type: 'text'; text: string } | ACPImageBlock> = [
      { type: 'text', text: prompt },
    ];
    const imageBlocks = toACPImageBlocks(images);
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
      this.flushDeferredToolInputs();

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
      this.flushDeferredToolInputs();
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

  // ── Permission request handling ─────────────────────────────

  /**
   * Handle an ACP `session/request_permission` from cursor-agent.
   *
   * Mirrors gemini-acp.ts so the existing UI (PermissionApprovalCard) and
   * persisted "always allow / always deny" rules light up unchanged:
   *
   * 1. In `autoEdit` mode, short-circuit to allow_always (funny's full-bypass
   *    semantics — equivalent to Claude's bypassPermissions / Gemini --yolo).
   * 2. Otherwise consult `permissionRuleLookup` for a saved rule → auto-resolve.
   * 3. Otherwise emit a synthetic `tool_use` + `tool_result` whose denial text
   *    matches the regex in `agent-message-handler.ts` so the client renders
   *    the approval card. Then PAUSE on `abortController.signal` until the
   *    runner kills the process (user approves and the new rule takes effect
   *    on the next run).
   */
  private async handleRequestPermission(
    params: ACPRequestPermissionRequest,
  ): Promise<ACPRequestPermissionResponse> {
    const { options, toolCall } = params;

    const findOption = (kinds: string[]): string | undefined =>
      options.find((opt) => kinds.includes(opt.kind))?.optionId;

    const allowOptionId =
      findOption(['allow_once']) ?? findOption(['allow_always']) ?? options[0]?.optionId ?? '';
    const rejectOptionId =
      findOption(['reject_once']) ?? findOption(['reject_always']) ?? options[0]?.optionId ?? '';

    // 1. autoEdit mode: full-bypass, never prompt.
    if (isAutoEditMode(this.options.originalPermissionMode)) {
      dlog.info('requestPermission ALLOW via autoEdit mode');
      return { outcome: { outcome: 'selected', optionId: allowOptionId } };
    }

    const acpKind = (toolCall.kind as string | undefined) ?? undefined;
    const title = toolCall.title ?? '';
    const toolName = inferACPToolName(acpKind, title, undefined, toolCall.rawInput);
    const toolInput = buildACPToolInput(toolName, {
      kind: acpKind,
      title,
      rawInput: toolCall.rawInput,
      locations: (toolCall as any).locations,
    });
    const toolInputForRule = serializeToolInputForRule(toolName, toolInput);

    // 2. Consult persisted rules.
    if (this.options.permissionRuleLookup) {
      try {
        const match = await this.options.permissionRuleLookup({
          toolName,
          toolInput: toolInputForRule,
        });
        if (match?.decision === 'allow') {
          dlog.info('requestPermission ALLOW via persisted rule', { toolName });
          return { outcome: { outcome: 'selected', optionId: allowOptionId } };
        }
        if (match?.decision === 'deny') {
          dlog.info('requestPermission DENY via persisted rule', { toolName });
          return { outcome: { outcome: 'selected', optionId: rejectOptionId } };
        }
      } catch (err) {
        dlog.warn('permissionRuleLookup threw — falling through', {
          toolName,
          error: String(err).slice(0, 200),
        });
      }
    }

    // 3. Surface a permission request via synthetic tool_use + tool_result.
    const toolUseId = toolCall.toolCallId ?? randomUUID();
    const denialText =
      `Cursor requested permissions to use ${toolName} but the user hasn't been granted approval. ` +
      `Waiting for user approval.`;

    this.emit('message', {
      type: 'assistant',
      message: {
        id: randomUUID(),
        content: [
          {
            type: 'tool_use',
            id: toolUseId,
            name: toolName,
            input: toolInput,
          },
        ],
      },
    } as CLIMessage);

    this.emit('message', {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: denialText,
          },
        ],
      },
    } as CLIMessage);

    dlog.info('requestPermission PAUSING for user approval', {
      toolName,
      toolCallId: toolUseId,
    });

    return await new Promise<ACPRequestPermissionResponse>((resolve) => {
      const onAbort = () => {
        dlog.info('requestPermission RESUMED (abort signal)', { toolName });
        resolve({ outcome: { outcome: 'selected', optionId: rejectOptionId } });
      };
      if (this.abortController.signal.aborted) {
        onAbort();
      } else {
        this.abortController.signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  // ── Update translation ──────────────────────────────────────

  /**
   * Emit a synthetic `tool_use` exactly once for a tool call id and mark it
   * seen. Resets the per-turn assistant-text accumulator so any following
   * agent text starts a fresh bubble.
   */
  private emitToolUse(toolCallId: string, toolName: string, input: Record<string, unknown>): void {
    this.deferredToolInputs.delete(toolCallId);
    this.toolCallsSeen.set(toolCallId, toolName);
    this.emit('message', {
      type: 'assistant',
      message: {
        id: randomUUID(),
        content: [{ type: 'tool_use', id: toolCallId, name: toolName, input }],
      },
    } as CLIMessage);
    this.accumulatedText = '';
    this.assistantMsgId = randomUUID();
  }

  private emitToolResult(toolCallId: string, content: string): void {
    this.toolCallsSeen.set(toolCallId, 'done');
    this.emit('message', {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: toolCallId, content }],
      },
    } as CLIMessage);
  }

  /**
   * Emit any tool calls still waiting for a renderable field at turn end. In
   * the normal flow every deferred call resolves via a later `tool_call_update`;
   * this is the safety net for a call that never updates (e.g. a dropped event).
   * A still-unrenderable call is discarded — an empty card (no path / no
   * command / no todos) is worse than no card at all.
   */
  private flushDeferredToolInputs(): void {
    if (this.deferredToolInputs.size === 0) return;
    for (const [toolCallId, { name, input }] of this.deferredToolInputs) {
      if (!isRenderableToolInput(name, input)) continue;
      this.emitToolUse(toolCallId, name, input);
    }
    this.deferredToolInputs.clear();
  }

  private translateUpdate(update: ACPSessionUpdate): void {
    if (this.replayingHistory && update.sessionUpdate !== 'usage_update') return;
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
          this.emit('message', {
            type: 'assistant',
            message: {
              id: this.assistantMsgId,
              content: [{ type: 'text', text: this.accumulatedText }],
            },
          } as CLIMessage);
          this.lastAssistantText = this.accumulatedText;
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
        const updateContent = (update as any).content as unknown[] | undefined;
        const toolName = inferACPToolName(acpKind, title, undefined, update.rawInput);

        dlog.debug('tool_call', {
          toolCallId,
          kind: acpKind,
          title,
          rawInput: update.rawInput,
          locations,
          content: updateContent,
          status: (update as any).status,
        });

        let input = buildACPToolInput(toolName, {
          kind: acpKind,
          title,
          rawInput: update.rawInput,
          locations,
          content: updateContent,
        });
        if (toolName === 'TodoWrite') {
          input = enrichTodoWriteInputFromOutput(input, update.rawOutput);
          const clean = buildTodoWriteInputFromRaw(input);
          if (clean) input = { todos: clean.todos };
        }

        const tcStatus = (update as any).status as string | undefined;
        const isTerminal = tcStatus === 'completed' || tcStatus === 'failed';

        // Defer when the card isn't renderable yet. A non-terminal call waits
        // for a later tool_call_update to supply the missing field; a terminal
        // call that still lacks it (e.g. Cursor fires a completed edit with no
        // diff/path) is dropped rather than emitted as an empty card — the
        // server freezes a tool's input at first emission.
        if (!isRenderableToolInput(toolName, input)) {
          if (!isTerminal) {
            this.deferredToolInputs.set(toolCallId, { name: toolName, input });
          } else {
            this.deferredToolInputs.delete(toolCallId);
          }
          return;
        }

        this.emitToolUse(toolCallId, toolName, input);
        if (isTerminal) {
          const tcOutput = extractACPToolOutput(update.rawOutput, updateContent, title);
          this.emitToolResult(toolCallId, tcOutput);
        }
        return;
      }

      case 'tool_call_update': {
        this.flushPendingThought();
        const toolCallId = update.toolCallId;
        const updateContent = (update as any).content as unknown[] | undefined;

        dlog.debug('tool_call_update', {
          toolCallId,
          kind: (update as any).kind,
          title: update.title,
          rawInput: (update as any).rawInput,
          rawOutput: update.rawOutput,
          locations: (update as any).locations,
          content: updateContent,
          status: update.status,
        });

        const isTerminal = update.status === 'completed' || update.status === 'failed';

        // Cursor can fire a completed tool_call_update without an emitted
        // tool_call — either because it skipped the initial event, or because
        // we deferred it waiting for the path. Merge any buffered input with
        // the update's richer data (locations / rawInput / content) and emit.
        if (!this.toolCallsSeen.has(toolCallId)) {
          const buffered = this.deferredToolInputs.get(toolCallId);
          const acpKind = (update as any).kind as string | undefined;
          const title = update.title || '';
          const locations = (update as any).locations as
            | Array<{ path: string; line?: number | null }>
            | undefined;
          // Trust the original tool name from the deferred tool_call — an
          // update often omits kind/title, which would degrade to 'Tool'.
          const rawInput = (update as any).rawInput;
          const toolName = buffered?.name ?? inferACPToolName(acpKind, title, undefined, rawInput);
          const built = buildACPToolInput(toolName, {
            kind: acpKind,
            title,
            rawInput,
            locations,
            content: updateContent,
          });
          let input = buffered ? mergeToolInput(buffered.input, built) : built;
          if (toolName === 'TodoWrite') {
            input = enrichTodoWriteInputFromOutput(input, update.rawOutput);
            const clean = buildTodoWriteInputFromRaw(input);
            if (clean) input = { todos: clean.todos };
          }

          if (!isRenderableToolInput(toolName, input)) {
            if (!isTerminal) {
              this.deferredToolInputs.set(toolCallId, { name: toolName, input });
            } else {
              // Terminal but still missing its renderable field (e.g. Cursor
              // fires a completed edit update with no diff/path). Drop it
              // entirely — no card and no dangling tool_result — rather than
              // surface an empty card.
              this.deferredToolInputs.delete(toolCallId);
            }
            return;
          }

          this.emitToolUse(toolCallId, toolName, input);
        }

        if (isTerminal) {
          const output = extractACPToolOutput(update.rawOutput, updateContent, update.title || '');
          this.emitToolResult(toolCallId, output);
        }
        return;
      }

      case 'plan': {
        this.flushPendingThought();
        const input = buildTodoWriteInputFromPlanEntries(update.entries);
        if (input.todos.length > 0) {
          // Render as a TodoWrite card (rich checklist) rather than a text
          // bubble. ACP replaces the whole plan on each update, so each
          // emission is its own card with a fresh id — matching how the Claude
          // SDK surfaces successive TodoWrite calls.
          const toolCallId = randomUUID();
          this.emit('message', {
            type: 'assistant',
            message: {
              id: randomUUID(),
              content: [{ type: 'tool_use', id: toolCallId, name: 'TodoWrite', input }],
            },
          } as CLIMessage);
          this.emit('message', {
            type: 'user',
            message: {
              content: [{ type: 'tool_result', tool_use_id: toolCallId, content: 'Plan updated' }],
            },
          } as CLIMessage);
          this.accumulatedText = '';
          this.assistantMsgId = randomUUID();
        }
        return;
      }

      // Ignore other update types (available_commands_update, current_mode_update, etc.)
      default:
        return;
    }
  }

  // ── Binary resolution ───────────────────────────────────────

  private resolveCursorAcpCommand(): { command: string; args: string[] } {
    const explicit = process.env.CURSOR_BINARY_PATH || process.env.ACP_CURSOR_BIN;
    if (explicit) return { command: explicit, args: ['acp'] };
    if (process.env.CURSOR_ACP_USE_NPX === '1') {
      return { command: 'npx', args: ['-y', 'cursor-agent', 'acp'] };
    }
    return { command: 'cursor-agent', args: ['acp'] };
  }
}

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Whether a built tool input has the primary field its client card needs to
 * render a meaningful summary. When it doesn't, the emission is deferred until
 * a later ACP update fills it in — otherwise the card renders empty (the
 * server freezes a tool's input at first emission).
 */
function isRenderableToolInput(toolName: string, input: Record<string, unknown>): boolean {
  const has = (key: string) => typeof input[key] === 'string' && (input[key] as string).length > 0;
  switch (toolName) {
    case 'Read':
    case 'Write':
    case 'Edit':
      return has('file_path');
    case 'Bash':
      return has('command');
    case 'Glob':
    case 'Grep':
      return has('pattern');
    case 'TodoWrite':
      return hasRenderableTodoInput(input);
    default:
      // Task / Think / WebFetch / etc. derive a usable summary from the
      // title-backed `description`, which buildACPToolInput always sets.
      return true;
  }
}

/**
 * Merge a buffered tool input with a freshly built one, preferring non-empty
 * values from `next`. Lets a later update supply the field (e.g. file_path)
 * that the initial deferred event was missing.
 */
function mergeToolInput(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...prev };
  for (const [key, value] of Object.entries(next)) {
    if (value !== undefined && value !== null && value !== '') {
      merged[key] = value;
    }
  }
  return merged;
}

/**
 * Match the serialization Claude SDK uses for permission-rule lookup so a
 * single rule (e.g. "Bash: git status") behaves the same regardless of
 * provider. Bash gets the raw command; everything else gets stable JSON.
 */
function serializeToolInputForRule(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
): string | undefined {
  if (!toolInput || typeof toolInput !== 'object') return undefined;
  if (toolName === 'Bash' && typeof toolInput.command === 'string') {
    return toolInput.command;
  }
  try {
    return JSON.stringify(toolInput);
  } catch {
    return undefined;
  }
}

/**
 * Detect funny's `autoEdit` mode — full permission bypass, equivalent to
 * Claude's `bypassPermissions` and Gemini `--yolo`. In this mode we
 * auto-approve every `session/request_permission` so cursor never pauses.
 */
function isAutoEditMode(originalPermissionMode: string | undefined): boolean {
  return originalPermissionMode === 'autoEdit';
}
