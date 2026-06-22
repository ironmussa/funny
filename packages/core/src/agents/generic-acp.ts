/**
 * GenericACPProcess — one manifest-parameterized adapter that wraps any
 * ACP-compliant agent CLI behind the IAgentProcess EventEmitter interface,
 * communicating via the Agent Client Protocol (ACP) over stdio.
 *
 * This is the hoist of the ~700-line skeleton that was duplicated across the
 * five per-provider adapters (codex/gemini/pi/cursor/opencode). All of the
 * shared lifecycle — spawn, initialize, newSession/loadSession, emitInit,
 * model-select, mode-set, the prompt turn loop, permission handling, and the
 * `translateUpdate` switch — lives here ONCE, parameterized by a
 * {@link ProviderManifest}. The small per-provider divergences are toggled by
 * the manifest's {@link QuirkFlags} (the Phase-0 audited set).
 *
 * Each provider becomes a zero-logic constructor shim that binds its manifest
 * (see `opencode-acp.ts`), so the existing per-provider test suites pass
 * unchanged.
 */

import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { Readable, Writable } from 'stream';

import type { ProviderManifest } from '@funny/shared/provider-manifest';
import { resolveSpawnCommand } from '@funny/shared/provider-manifest';

import { createDebugLogger, type DebugLogger } from '../debug.js';
import { toACPImageBlocks, type ACPImageBlock } from './acp-image.js';
import { toACPMcpServers } from './acp-mcp.js';
import {
  buildACPToolInput,
  buildTodoWriteInputFromPlanEntries,
  buildTodoWriteInputFromRaw,
  enrichTodoWriteInputFromOutput,
  extractACPToolOutput,
  hasRenderableTodoInput,
  inferACPToolName,
  parseACPPreambleTitle,
} from './acp-tool-input.js';
import { BaseAgentProcess, killProcessTree, type ResultSubtype } from './base-process.js';
import type { CLIMessage, ClaudeProcessOptions } from './types.js';

// Lazy-loaded SDK types (avoid crash if not installed)
type ACPSDK = typeof import('@agentclientprotocol/sdk');
type ACPClient = import('@agentclientprotocol/sdk').Client;
type ACPAgent = import('@agentclientprotocol/sdk').Agent;
type ACPSessionNotification = import('@agentclientprotocol/sdk').SessionNotification;
type ACPSessionUpdate = import('@agentclientprotocol/sdk').SessionUpdate;
type ACPRequestPermissionRequest = import('@agentclientprotocol/sdk').RequestPermissionRequest;
type ACPRequestPermissionResponse = import('@agentclientprotocol/sdk').RequestPermissionResponse;
type ACPConnection = import('@agentclientprotocol/sdk').ClientSideConnection;

export class GenericACPProcess extends BaseAgentProcess {
  protected readonly manifest: ProviderManifest;
  private readonly dlog: DebugLogger;
  private childProcess: ChildProcess | null = null;

  // ── Long-lived per-process state ─────────────────────────────────
  private connection: ACPConnection | null = null;
  private activeSessionId: string | null = null;
  private numTurns = 0;
  private totalCost = 0;
  /** True if the agent advertises `promptCapabilities.image` at init. */
  private supportsImages = false;
  /**
   * The agent's "model" select config option, captured from the newSession
   * response (ACP 0.26+ replaced the dedicated `unstable_setSessionModel`
   * method with the generic session-config-option mechanism). Holds the
   * option's `configId` and the set of selectable value ids so the model can
   * be applied via `setSessionConfigOption`.
   */
  private modelConfigOption: { configId: string; valueIds: Set<string> } | null = null;
  /**
   * The agent's "thought level" / reasoning-effort select config option,
   * captured from the newSession response. Some ACP agents expose this as
   * `category: 'thought_level'` with values like low/medium/high/xhigh.
   */
  private thoughtLevelConfigOption: { configId: string; valueIds: Set<string> } | null = null;
  /** True once a model-selection fallback has been surfaced to the user this process. */
  private modelFallbackNotified = false;

  // ── Per-turn state (reset on each runOnePrompt) ──────────────────
  private assistantMsgId: string = randomUUID();
  private accumulatedText = '';
  private toolCallsSeen = new Map<string, string>();
  private lastAssistantText = '';
  /** Buffer for `agent_thought_chunk` text — collapsed into a single Think tool call. */
  private pendingThought: { id: string; text: string } | null = null;
  /**
   * Count of `message` events emitted during the current turn. Drives the
   * empty-turn guard: an ACP `end_turn` that produced zero messages (no text,
   * no tool calls, no thought) is surfaced as a visible notice instead of a
   * silent "success" the user reads as the agent not responding.
   */
  private turnEmitCount = 0;
  /**
   * Tool calls whose initial event lacked the field its card needs to render.
   * Buffered until an update carries the missing field, or dropped at terminal
   * status. Only used when `quirks.deferUnrenderableToolInput`.
   */
  private deferredToolInputs = new Map<string, { name: string; input: Record<string, unknown> }>();

  /** True while loadSession is replaying historical events. */
  private replayingHistory = false;

  constructor(options: ClaudeProcessOptions, manifest: ProviderManifest) {
    super(options);
    this.manifest = manifest;
    this.dlog = createDebugLogger(`acp-${manifest.id}`);
  }

  /**
   * Emit a CLI `message` and count it toward the current turn's empty-turn
   * guard. ALL visible output (assistant text, tool calls, thoughts, permission
   * cards) must go through here so {@link runOnePrompt} can tell a genuinely
   * empty turn from one that produced something.
   */
  private emitMessage(msg: CLIMessage): void {
    this.turnEmitCount++;
    this.emit('message', msg);
  }

  private flushPendingThought(): void {
    if (!this.pendingThought) return;
    const { id, text } = this.pendingThought;
    this.pendingThought = null;
    if (!text.trim()) return;

    this.emitMessage({
      type: 'assistant',
      message: {
        id: randomUUID(),
        content: [{ type: 'tool_use', id, name: 'Think', input: { content: text } }],
      },
    } as CLIMessage);

    this.emitMessage({
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
      killProcessTree(this.childProcess);
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
          `Also ensure ${this.manifest.label} is installed and on PATH.`,
      );
    }

    const { ClientSideConnection, ndJsonStream } = SDK;

    await this.runPrelaunch();

    const { command, args } = this.resolveCommand();
    this.dlog.info('spawning acp agent', { command, args, cwd: this.options.cwd });

    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      signal: this.abortController.signal,
      shell: process.platform === 'win32',
      // Lead our own process group (POSIX) so kill() can reap the whole tree,
      // including MCP servers the agent spawns as grandchildren.
      detached: process.platform !== 'win32',
    });

    this.childProcess = child;

    child.on('error', (err: any) => {
      if (!this._exited && !this.isAborted) {
        if (err.code === 'ENOENT') {
          this.emit(
            'error',
            new Error(
              `'${this.manifest.spawn.command}' binary not found in PATH or failed to spawn. ` +
                `Install ${this.manifest.label}, or set ${this.manifest.spawn.binEnvVars[0]} to a custom location.`,
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
        this.dlog.warn('acp child exited unexpectedly', { code, signal });
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
      const mcpServerList = this.manifest.quirks.filterMcpByCapability
        ? allMcp.filter((s) => {
            const t = (s as { type?: string }).type;
            if (t === 'http') return supportsHttp;
            if (t === 'sse') return supportsSse;
            return true;
          })
        : allMcp;
      if (allMcp.length !== mcpServerList.length) {
        this.dlog.warn('dropped MCP servers unsupported by agent', {
          dropped: allMcp.length - mcpServerList.length,
          mcpCapabilities: mcpCaps,
        });
      }

      const isResume = Boolean(this.options.sessionId && supportsLoadSession);
      if (isResume) {
        this.activeSessionId = this.options.sessionId!;
        this.replayingHistory = true;
        try {
          const loadResponse = await connection.loadSession({
            sessionId: this.options.sessionId!,
            cwd: this.options.cwd,
            mcpServers: mcpServerList,
          });
          // `loadSession` returns the same `configOptions` as `newSession`
          // (ACP 0.26+). Capture them here too, otherwise `applyModelSelection`
          // has no model config option to set on resume and silently falls back
          // to the provider default — losing the user's model choice on every
          // follow-up message.
          this.captureSessionConfigOptions(
            (loadResponse as { configOptions?: unknown } | undefined)?.configOptions,
          );
        } finally {
          this.replayingHistory = false;
        }
      } else {
        sessionResponse = await connection.newSession({
          cwd: this.options.cwd,
          mcpServers: mcpServerList,
        });
        this.activeSessionId = sessionResponse.sessionId;
        this.captureSessionConfigOptions(sessionResponse.configOptions);
      }

      this.emitInit(
        this.activeSessionId,
        this.manifest.builtinTools,
        this.options.model ?? 'default',
        this.options.cwd,
      );

      await this.applyModelSelection(connection);
      await this.applyThoughtLevelSelection(connection);
      await this.applySessionMode(connection, isResume);

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
        killProcessTree(this.childProcess);
      }
      this.connection = null;
      this.finalize();
    }
  }

  /**
   * Named pre-launch side effect from the manifest (the only imperative
   * selector). gemini's trusted-folder write exists solely to keep `--yolo`
   * from being downgraded, so it runs only when the `--yolo` flag is applied.
   */
  private async runPrelaunch(): Promise<void> {
    if (
      this.manifest.prelaunch === 'gemini-trust-folder' &&
      this.manifest.modeVia === 'cli-flag' &&
      this.options.originalPermissionMode === 'autoEdit'
    ) {
      await ensureGeminiTrustedFolder(this.options.cwd, this.dlog);
    }
  }

  /** Resolve the spawn command + args from the manifest (env override → npx → default). */
  private resolveCommand(): { command: string; args: string[] } {
    const { command, args: baseArgs } = resolveSpawnCommand(this.manifest.spawn);
    const args = [...baseArgs];
    // gemini selects its model via the `--model` CLI arg (modelVia: 'cli-arg').
    if (
      this.manifest.modelVia === 'cli-arg' &&
      this.options.model &&
      this.options.model !== 'default'
    ) {
      args.push('--model', this.options.model);
    }
    // gemini applies funny's autoEdit (full bypass) via the `--yolo` launch flag.
    if (
      this.manifest.modeVia === 'cli-flag' &&
      this.options.originalPermissionMode === 'autoEdit'
    ) {
      args.push('--yolo');
    }
    return { command, args };
  }

  /**
   * Record a model-selection fallback: keep the existing debug warn (for log
   * greppability) AND surface it to the user once per process as a visible
   * notice. Without the visible half, asking for model X and silently getting
   * the provider default is indistinguishable from the model being honored.
   */
  private notifyModelFallback(
    requestedModel: string,
    logMessage: string,
    detail: Record<string, unknown> = {},
  ): void {
    this.dlog.warn(logMessage, { modelId: requestedModel, ...detail });
    if (this.modelFallbackNotified) return;
    this.modelFallbackNotified = true;
    this.emitMessage({
      type: 'assistant',
      message: {
        id: randomUUID(),
        content: [
          {
            type: 'text',
            text:
              `Requested model \`${requestedModel}\` could not be applied to ${this.manifest.label} ` +
              `via ACP — running on the provider's configured default model instead.`,
          },
        ],
      },
    } as CLIMessage);
  }

  /**
   * Select the requested model after session setup, per the manifest's
   * `setModel` strategy. Skips the sentinel `default` (= the provider's
   * configured default). For `modelVia: 'cli-arg'` (gemini) the model is
   * already on the launch args — nothing to do here.
   */
  private async applyModelSelection(connection: ACPConnection): Promise<void> {
    if (this.manifest.modelVia !== 'acp-method' || !this.manifest.setModel) return;
    const requestedModel = this.options.model;
    if (!requestedModel || requestedModel === 'default' || !this.activeSessionId) return;

    const conn = connection as any;
    const declaredMethod = this.manifest.setModel.method;
    try {
      // opencode implements the raw method without advertising the capability.
      if (declaredMethod === 'session/set_model') {
        await conn.extMethod('session/set_model', {
          sessionId: this.activeSessionId,
          modelId: requestedModel,
        });
        this.dlog.info('model selected', { via: 'session/set_model', modelId: requestedModel });
        return;
      }

      // ACP 0.26+ removed the dedicated `unstable_setSessionModel` method —
      // the model is now a `category: 'model'` session config option set via
      // `setSessionConfigOption`. Prefer this when the agent advertised it.
      if (typeof conn.setSessionConfigOption === 'function' && this.modelConfigOption) {
        const { configId, valueIds } = this.modelConfigOption;
        if (valueIds.size > 0 && !valueIds.has(requestedModel)) {
          this.notifyModelFallback(
            requestedModel,
            'requested model not offered by agent — using provider default',
            { available: [...valueIds] },
          );
          return;
        }
        await conn.setSessionConfigOption({
          sessionId: this.activeSessionId,
          configId,
          value: requestedModel,
        });
        this.dlog.info('model selected', {
          via: 'setSessionConfigOption',
          configId,
          modelId: requestedModel,
        });
        return;
      }

      // Legacy SDK fallback (<0.26): the typed `unstable_setSessionModel` method.
      if (typeof conn.unstable_setSessionModel === 'function') {
        await conn.unstable_setSessionModel({
          sessionId: this.activeSessionId,
          modelId: requestedModel,
        });
        this.dlog.info('model selected', {
          via: 'unstable_setSessionModel',
          modelId: requestedModel,
        });
        return;
      }

      this.notifyModelFallback(
        requestedModel,
        'no model-selection method on ACP connection — using provider default',
      );
    } catch (e) {
      this.notifyModelFallback(
        requestedModel,
        'set-model failed — falling back to provider default',
        {
          error: (e as Error)?.message,
        },
      );
    }
  }

  /**
   * Capture the agent's "model" select config option from a newSession
   * response so {@link applyModelSelection} can apply the model via
   * `setSessionConfigOption` (ACP 0.26+). Flattens grouped option lists and
   * records the configId + selectable value ids. No-op when the agent does
   * not advertise a model option.
   */
  private captureModelConfigOption(configOptions: unknown): void {
    this.modelConfigOption = null;
    if (!Array.isArray(configOptions)) return;
    for (const opt of configOptions) {
      const o = opt as Record<string, unknown> | null;
      if (!o || o.category !== 'model' || o.type !== 'select') continue;
      const valueIds = this.collectSelectValueIds(o.options);
      this.modelConfigOption = { configId: String(o.id), valueIds };
      return;
    }
  }

  private captureThoughtLevelConfigOption(configOptions: unknown): void {
    this.thoughtLevelConfigOption = null;
    if (!Array.isArray(configOptions)) return;
    for (const opt of configOptions) {
      const o = opt as Record<string, unknown> | null;
      if (!o || o.category !== 'thought_level' || o.type !== 'select') continue;
      const valueIds = this.collectSelectValueIds(o.options);
      this.thoughtLevelConfigOption = { configId: String(o.id), valueIds };
      return;
    }
  }

  private captureSessionConfigOptions(configOptions: unknown): void {
    this.captureModelConfigOption(configOptions);
    this.captureThoughtLevelConfigOption(configOptions);
  }

  private collectSelectValueIds(options: unknown): Set<string> {
    const valueIds = new Set<string>();
    const collect = (entries: unknown): void => {
      if (!Array.isArray(entries)) return;
      for (const e of entries) {
        const entry = e as Record<string, unknown> | null;
        if (!entry) continue;
        if (typeof entry.value === 'string') valueIds.add(entry.value);
        if (Array.isArray(entry.options)) collect(entry.options);
      }
    };
    collect(options);
    return valueIds;
  }

  private async applyThoughtLevelSelection(connection: ACPConnection): Promise<void> {
    if (!this.activeSessionId || !this.options.effort) return;
    const conn = connection as any;
    if (typeof conn.setSessionConfigOption !== 'function' || !this.thoughtLevelConfigOption) return;

    const requestedEffort = this.options.effort === 'max' ? 'xhigh' : this.options.effort;
    const { configId, valueIds } = this.thoughtLevelConfigOption;
    if (valueIds.size > 0 && !valueIds.has(requestedEffort)) {
      this.dlog.warn('thought level not offered by agent — using provider default', {
        requestedEffort,
        available: [...valueIds],
      });
      return;
    }

    try {
      await conn.setSessionConfigOption({
        sessionId: this.activeSessionId,
        configId,
        value: requestedEffort,
      });
      this.dlog.info('thought level selected', {
        via: 'setSessionConfigOption',
        configId,
        effort: requestedEffort,
      });
    } catch (e) {
      this.emitErrorToolCall(
        `**${this.manifest.label}:** unable to set thought level "${requestedEffort}" — ${this.extractErrorMessage(e)}`,
      );
    }
  }

  /**
   * Apply the session/permission mode per the manifest. Only `acp-setSessionMode`
   * providers call `setSessionMode`; `cli-flag` (gemini) and `none` (pi/cursor)
   * are handled at spawn time or not at all. Mode is set only on a fresh session
   * — a resumed session keeps its previously approved mode.
   */
  private async applySessionMode(connection: ACPConnection, isResume: boolean): Promise<void> {
    if (this.manifest.modeVia !== 'acp-setSessionMode' || isResume || !this.activeSessionId) return;
    const funnyMode = this.options.originalPermissionMode ?? this.options.permissionMode;
    const desiredMode = this.manifest.modeMap[funnyMode as keyof typeof this.manifest.modeMap];
    if (!desiredMode) return;
    try {
      await connection.setSessionMode({ sessionId: this.activeSessionId, modeId: desiredMode });
      this.dlog.info('session mode applied', { modeId: desiredMode });
    } catch (e) {
      this.emitErrorToolCall(
        `**${this.manifest.label}:** unable to switch to session mode "${desiredMode}" — ${this.extractErrorMessage(e)}`,
      );
    }
  }

  // ── Per-turn execution ──────────────────────────────────────────

  protected async runOnePrompt(prompt: string, images?: unknown[]): Promise<void> {
    if (!this.connection || !this.activeSessionId) {
      throw new Error(`${this.manifest.label} ACP: connection not initialized`);
    }

    // Reset per-turn state.
    this.assistantMsgId = randomUUID();
    this.accumulatedText = '';
    this.toolCallsSeen.clear();
    this.deferredToolInputs.clear();
    this.lastAssistantText = '';
    this.pendingThought = null;
    this.turnEmitCount = 0;

    const startTime = Date.now();

    const promptBlocks: Array<{ type: 'text'; text: string } | ACPImageBlock> = [
      { type: 'text', text: prompt },
    ];
    const imageBlocks = toACPImageBlocks(images);
    if (imageBlocks.length > 0) {
      if (this.supportsImages) {
        promptBlocks.push(...imageBlocks);
      } else {
        this.dlog.warn('agent does not advertise promptCapabilities.image — dropping images', {
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

      // Empty-turn guard: a turn that the agent reports as completed but which
      // produced no visible output at all (no assistant text, no tool calls, no
      // thought) reads to the user as the agent silently not responding. Surface
      // it as a visible notice instead of an empty "success".
      if (this.turnEmitCount === 0 && !this.isAborted) {
        const notice =
          `${this.manifest.label} ended the turn without producing any output ` +
          `(stopReason: ${promptResponse.stopReason ?? 'unknown'}) — no text, tool calls, ` +
          `or reasoning. This usually means the model was not applied or the backend ` +
          `returned nothing.`;
        this.dlog.warn('empty turn — agent produced no output', {
          stopReason: promptResponse.stopReason,
          modelId: this.options.model,
        });
        this.emitMessage({
          type: 'assistant',
          message: { id: randomUUID(), content: [{ type: 'text', text: notice }] },
        } as CLIMessage);
        this.lastAssistantText = notice;
      }

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
   * Handle an ACP `session/request_permission`. The manifest's
   * `quirks.permissionModel` selects the behavior:
   *   - `auto-allow` (pi): approve every request without gating.
   *   - `gated` (default): autoEdit → allow; else consult persisted rules; else
   *     surface a synthetic tool_use + tool_result so the PermissionApprovalCard
   *     renders, and PAUSE until the runner kills the process.
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

    // auto-allow providers (pi) never gate.
    if (this.manifest.quirks.permissionModel === 'auto-allow') {
      return { outcome: { outcome: 'selected', optionId: allowOptionId } };
    }

    // 1. autoEdit mode: full-bypass, never prompt.
    if (this.options.originalPermissionMode === 'autoEdit') {
      this.dlog.info('requestPermission ALLOW via autoEdit mode');
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
          this.dlog.info('requestPermission ALLOW via persisted rule', { toolName });
          return { outcome: { outcome: 'selected', optionId: allowOptionId } };
        }
        if (match?.decision === 'deny') {
          this.dlog.info('requestPermission DENY via persisted rule', { toolName });
          return { outcome: { outcome: 'selected', optionId: rejectOptionId } };
        }
      } catch (err) {
        this.dlog.warn('permissionRuleLookup threw — falling through', {
          toolName,
          error: String(err).slice(0, 200),
        });
      }
    }

    // 3. Surface a permission request via synthetic tool_use + tool_result.
    const toolUseId = toolCall.toolCallId ?? randomUUID();
    const denialText =
      `${this.manifest.label} requested permissions to use ${toolName} but the user hasn't been granted approval. ` +
      `Waiting for user approval.`;

    this.emitMessage({
      type: 'assistant',
      message: {
        id: randomUUID(),
        content: [{ type: 'tool_use', id: toolUseId, name: toolName, input: toolInput }],
      },
    } as CLIMessage);

    this.emitMessage({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: toolUseId, content: denialText }],
      },
    } as CLIMessage);

    this.dlog.info('requestPermission PAUSING for user approval', {
      toolName,
      toolCallId: toolUseId,
    });

    return await new Promise<ACPRequestPermissionResponse>((resolve) => {
      const onAbort = () => {
        this.dlog.info('requestPermission RESUMED (abort signal)', { toolName });
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
    this.emitMessage({
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
    this.emitMessage({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: toolCallId, content }],
      },
    } as CLIMessage);
  }

  /**
   * Emit any tool calls still waiting for a renderable field at turn end. Only
   * relevant for `deferUnrenderableToolInput` providers. A still-unrenderable
   * call is discarded — an empty card is worse than no card.
   */
  private flushDeferredToolInputs(): void {
    if (this.deferredToolInputs.size === 0) return;
    for (const [toolCallId, { name, input }] of this.deferredToolInputs) {
      if (!isRenderableToolInput(name, input)) continue;
      this.emitToolUse(toolCallId, name, input);
    }
    this.deferredToolInputs.clear();
  }

  protected translateUpdate(update: ACPSessionUpdate): void {
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
          // codex emits several distinct status messages within one turn as
          // separate chunks with no tool call between them; concatenating with
          // no separator produces run-ons (`…render.Aviso…`). Re-insert the
          // dropped boundary ONLY at the exact glue signature: accumulated text
          // ends with terminal punctuation and the incoming chunk starts with an
          // uppercase letter, with no whitespace at the junction. Real token
          // streaming keeps the model's own spacing, so a single streamed
          // message never matches and is never split.
          if (
            this.manifest.quirks.splitGluedAgentMessages &&
            /[.!?:]$/.test(this.accumulatedText) &&
            /^\p{Lu}/u.test(content.text)
          ) {
            this.accumulatedText += '\n\n';
          }
          this.accumulatedText += content.text;
          // pi prefixes its agent message with a banner — strip it (data regex
          // from the manifest) so the user never sees the boilerplate. The
          // regex is anchored at ^, so stripping every emission is idempotent.
          // When the stripped text is empty (banner only, no real text yet),
          // emit nothing.
          const bannerSrc = this.manifest.quirks.stripFirstMessageBanner;
          const visible = bannerSrc
            ? stripBanner(this.accumulatedText, bannerSrc)
            : this.accumulatedText;
          if (visible) {
            this.emitMessage({
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
        const toolCallId = update.toolCallId;
        const acpKind = (update as any).kind as string | undefined;
        const title = update.title || '';

        // codex/gemini emit "preamble" tool_calls whose title is just
        // `[cwd …] (reason)` — narration before the next real tool. Buffer them
        // as Think text so they collapse into one Think card instead of a stack
        // of broken tool cards; the matching completion is swallowed below.
        if (this.manifest.quirks.bufferPreambleAsThink) {
          const preamble = parseACPPreambleTitle(title);
          if (preamble) {
            if (!this.pendingThought) this.pendingThought = { id: randomUUID(), text: '' };
            this.pendingThought.text += (this.pendingThought.text ? '\n' : '') + preamble;
            this.toolCallsSeen.set(toolCallId, 'preamble');
            return;
          }
        }

        this.flushPendingThought();
        if (this.toolCallsSeen.has(toolCallId)) return;

        const locations = (update as any).locations as
          | Array<{ path: string; line?: number | null }>
          | undefined;
        const updateContent = (update as any).content as unknown[] | undefined;
        const toolName = inferACPToolName(acpKind, title, undefined, update.rawInput);

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

        // Defer when the card isn't renderable yet (deferUnrenderableToolInput
        // providers). A non-terminal call waits for a later tool_call_update; a
        // terminal call that still lacks the field is dropped, not emitted empty.
        if (
          this.manifest.quirks.deferUnrenderableToolInput &&
          !isRenderableToolInput(toolName, input)
        ) {
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
        const toolCallId = update.toolCallId;
        // Swallow the completion of a buffered preamble tool_call (codex/gemini)
        // — its text already went into the Think buffer; no stray tool_result.
        if (this.toolCallsSeen.get(toolCallId) === 'preamble') return;
        this.flushPendingThought();
        const updateContent = (update as any).content as unknown[] | undefined;
        const isTerminal = update.status === 'completed' || update.status === 'failed';

        // An update for a tool call we never emitted: either the agent skipped
        // the initial event, or we deferred it. Synthesize the tool_use from the
        // richer update data. Only for synthToolUseFromOrphanUpdate providers.
        if (!this.toolCallsSeen.has(toolCallId)) {
          if (!this.manifest.quirks.synthToolUseFromOrphanUpdate) {
            if (isTerminal) {
              const output = extractACPToolOutput(
                update.rawOutput,
                updateContent,
                update.title || '',
              );
              this.emitToolResult(toolCallId, output);
            }
            return;
          }
          const buffered = this.deferredToolInputs.get(toolCallId);
          const acpKind = (update as any).kind as string | undefined;
          const title = update.title || '';
          const locations = (update as any).locations as
            | Array<{ path: string; line?: number | null }>
            | undefined;
          const rawInput = (update as any).rawInput;
          // Trust the original tool name from the deferred tool_call — an update
          // often omits kind/title, which would degrade to 'Tool'.
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

          if (
            this.manifest.quirks.deferUnrenderableToolInput &&
            !isRenderableToolInput(toolName, input)
          ) {
            if (!isTerminal) {
              this.deferredToolInputs.set(toolCallId, { name: toolName, input });
            } else {
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
        if (this.manifest.quirks.planRender === 'todoCard') {
          const input = buildTodoWriteInputFromPlanEntries(update.entries);
          if (input.todos.length > 0) {
            // ACP replaces the whole plan on each update, so each emission is its
            // own card with a fresh id — matching how the Claude SDK surfaces
            // successive TodoWrite calls.
            const toolCallId = randomUUID();
            this.emitMessage({
              type: 'assistant',
              message: {
                id: randomUUID(),
                content: [{ type: 'tool_use', id: toolCallId, name: 'TodoWrite', input }],
              },
            } as CLIMessage);
            this.emitMessage({
              type: 'user',
              message: {
                content: [
                  { type: 'tool_result', tool_use_id: toolCallId, content: 'Plan updated' },
                ],
              },
            } as CLIMessage);
            this.accumulatedText = '';
            this.assistantMsgId = randomUUID();
          }
        } else {
          // planRender 'text': render as a numbered markdown checklist under a
          // `**Plan:**` header (completed → [x], in_progress → [~], else [ ]).
          // Reuses the live assistant message id; does NOT rotate it.
          const entries = ((update as any).entries ?? []) as Array<Record<string, any>>;
          if (entries.length > 0) {
            const planText = entries
              .map((e, i) => {
                const status =
                  e.status === 'completed' ? '[x]' : e.status === 'in_progress' ? '[~]' : '[ ]';
                return `${status} ${i + 1}. ${e.title ?? e.description ?? 'Task'}`;
              })
              .join('\n');

            // codex: a `plan` arrives while a Task (switch_mode) tool_call is
            // still in flight — close it out with the rendered plan as its
            // tool_result. Harmless for providers with no open Task call.
            for (const [tcId, tcState] of this.toolCallsSeen) {
              if (tcState === 'Task') {
                this.toolCallsSeen.set(tcId, 'done');
                this.emitMessage({
                  type: 'user',
                  message: {
                    content: [{ type: 'tool_result', tool_use_id: tcId, content: planText }],
                  },
                } as CLIMessage);
              }
            }

            this.emitMessage({
              type: 'assistant',
              message: {
                id: this.assistantMsgId,
                content: [{ type: 'text', text: `**Plan:**\n${planText}` }],
              },
            } as CLIMessage);
          }
        }
        return;
      }

      // Built-in / dynamic slash commands the ACP agent advertises. Surface them
      // through the same `commands_changed` channel the Claude SDK uses, so the
      // send-boundary guard and the composer autocomplete see this provider's
      // commands instead of nothing. (Previously dropped on the floor.)
      case 'available_commands_update': {
        const commands = (((update as any).availableCommands ?? []) as Array<{ name?: string }>)
          .map((c) => c.name)
          .filter((n): n is string => typeof n === 'string' && n.length > 0);
        this.emitMessage({
          type: 'commands_changed',
          commands,
          sessionId: this.activeSessionId ?? '',
        } as CLIMessage);
        return;
      }

      // Ignore other update types (current_mode_update, etc.)
      default:
        return;
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Whether a built tool input has the primary field its client card needs to
 * render a meaningful summary. Used by `deferUnrenderableToolInput` providers.
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
      return true;
  }
}

/**
 * Merge a buffered tool input with a freshly built one, preferring non-empty
 * values from `next` (e.g. a file_path the initial deferred event was missing).
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
 * Match the serialization Claude SDK uses for permission-rule lookup so a single
 * rule (e.g. "Bash: git status") behaves the same regardless of provider.
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
 * Max prefix length the banner regex is applied to. The banner always sits at
 * the very start (the source is also length-capped at validation), so bounding
 * the regex input to a fixed head is behavior-preserving for real banners while
 * preventing catastrophic backtracking (ReDoS) from running against an
 * arbitrarily long message body — the runtime half of the §1.3 guard.
 */
const BANNER_SCAN_LIMIT = 8192;

/** Strip a provider banner (manifest regex-as-data) from the start of text. */
function stripBanner(text: string, regexSource: string): string {
  try {
    const re = new RegExp(regexSource);
    if (text.length <= BANNER_SCAN_LIMIT) return text.replace(re, '').replace(/^\s+/, '');
    const head = text.slice(0, BANNER_SCAN_LIMIT).replace(re, '').replace(/^\s+/, '');
    return head + text.slice(BANNER_SCAN_LIMIT);
  } catch {
    return text;
  }
}

/**
 * Mark the cwd as a trusted folder for gemini's `--yolo` mode by writing to
 * `~/.gemini/trustedFolders.json`. gemini-cli silently downgrades `--yolo` to
 * default approval unless the folder is pre-trusted. The ONLY imperative
 * prelaunch selector — named in core, never authored by a manifest.
 */
async function ensureGeminiTrustedFolder(cwd: string, dlog: DebugLogger): Promise<void> {
  try {
    const os = await import('os');
    const path = await import('path');
    const fs = await import('fs/promises');
    const trustedPath = path.join(os.homedir(), '.gemini', 'trustedFolders.json');
    let trusted: Record<string, string> = {};
    try {
      trusted = JSON.parse(await fs.readFile(trustedPath, 'utf-8')) as Record<string, string>;
    } catch {
      // file missing / unreadable — start fresh
    }
    if (trusted[cwd] === 'TRUST_FOLDER') return;
    trusted[cwd] = 'TRUST_FOLDER';
    await fs.mkdir(path.dirname(trustedPath), { recursive: true });
    await fs.writeFile(trustedPath, JSON.stringify(trusted, null, 2));
    dlog.info('marked folder as TRUST_FOLDER for gemini yolo mode', { cwd, trustedPath });
  } catch (e) {
    dlog.warn('failed to mark gemini trusted folder', { cwd, error: (e as Error)?.message });
  }
}
