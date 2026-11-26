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

import type { JsonObject } from '@funny/shared/json';
import type { ProviderManifest } from '@funny/shared/provider-manifest';
import { resolveSpawnCommand, type SpawnCommand } from '@funny/shared/provider-manifest';

import { createDebugLogger, type DebugLogger } from '../debug.js';
import { toACPImageBlocks, type ACPImageBlock } from './acp-image.js';
import { toACPMcpServers } from './acp-mcp.js';
import { childAcpStream } from './acp-stream.js';
import {
  buildACPToolInput,
  buildTodoWriteInputFromPlanEntries,
  extractACPToolOutput,
  inferACPToolName,
  parseACPPreambleTitle,
} from './acp-tool-input.js';
import { BaseAgentProcess, killProcessTree } from './base-process.js';
import {
  readToolCallFields,
  isTerminalToolStatus,
  finalizeTodoInput,
  formatPlanChecklist,
  isRenderableToolInput,
  mergeToolInput,
  serializeToolInputForRule,
  stripBanner,
  stopReasonToSubtype,
  toolResultMessage,
  toolUseMessage,
  findSelectConfigOption,
  type ACPSDK,
  type ACPSessionUpdate,
  type ACPRequestPermissionRequest,
  type ACPRequestPermissionResponse,
  type ACPConnection,
  type ACPPromptRequest,
  type ACPSessionConfigOptions,
  type ACPAgentContext,
  type ACPMethods,
  type ACPUpdateOf,
  type ACPContentBlock,
  type ACPToolCallUpdateLike,
  type ACPPlanUpdate,
  type ACPToolCallFields,
  type ModelFallbackDetail,
  type PlanTextEntry,
  type SelectConfigOption,
} from './generic-acp-helpers.js';
import { buildAgentChildEnv } from './reap-orphaned-agents.js';
import type { CLIMessage, ClaudeProcessOptions } from './types.js';

export class GenericACPProcess extends BaseAgentProcess {
  protected readonly manifest: ProviderManifest;
  private readonly dlog: DebugLogger;
  private childProcess: ChildProcess | null = null;

  // ── Long-lived per-process state ─────────────────────────────────
  private connection: ACPConnection | null = null;
  private acpMethods: ACPMethods | null = null;
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
  private modelConfigOption: SelectConfigOption | null = null;
  /**
   * The agent's "thought level" / reasoning-effort select config option,
   * captured from the newSession response. Some ACP agents expose this as
   * `category: 'thought_level'` with values like low/medium/high/xhigh.
   */
  private thoughtLevelConfigOption: SelectConfigOption | null = null;
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
  private deferredToolInputs = new Map<string, { name: string; input: JsonObject }>();

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

    this.emitMessage(toolUseMessage(id, 'Think', { content: text }));
    this.emitMessage(toolResultMessage(id, text));
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
    if (!this.acpMethods) return null;
    const sessionId = this.activeSessionId;
    const agent = this.connection.agent;
    const methods = this.acpMethods;
    return {
      sessionId,
      cancel: async () => {
        await agent.notify(methods.agent.session.cancel, { sessionId });
      },
    };
  }

  // ── Provider-specific run loop ─────────────────────────────────

  protected async runProcess(): Promise<void> {
    let SDK: ACPSDK;
    try {
      SDK = await import('@agentclientprotocol/sdk/unstable');
    } catch {
      throw new Error(
        'ACP SDK not installed. Run: bun add @agentclientprotocol/sdk\n' +
          `Also ensure ${this.manifest.label} is installed and on PATH.`,
      );
    }

    const { client, methods, ndJsonStream } = SDK;
    this.acpMethods = methods;

    await this.runPrelaunch();

    const { command, args } = this.resolveCommand();
    this.dlog.info('spawning acp agent', { command, args, cwd: this.options.cwd });

    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.options.cwd,
      // Stamp FUNNY_AGENT_OWNER=<runtime pid> so a future instance can reap this
      // agent if the runtime dies (full --watch restart) and orphans it.
      env: buildAgentChildEnv(this.options.env),
      signal: this.abortController.signal,
      shell: process.platform === 'win32',
      // Lead our own process group (POSIX) so kill() can reap the whole tree,
      // including MCP servers the agent spawns as grandchildren.
      detached: process.platform !== 'win32',
    });

    this.childProcess = child;

    this.watchChildErrors(
      child,
      () =>
        `'${this.manifest.spawn.command}' binary not found in PATH or failed to spawn. ` +
        `Install ${this.manifest.label}, or set ${this.manifest.spawn.binEnvVars[0]} to a custom location.`,
    );

    // If the child exits unexpectedly, wake the run loop so cleanup happens.
    child.on('exit', (code, signal) => {
      if (!this.isAborted && !this.hasExited) {
        this.dlog.warn('acp child exited unexpectedly', { code, signal });
        this.abortController.abort();
      }
    });

    this.forwardStderrErrors(child);
    if (!(await this.waitForSpawn(child))) return;

    const connection = client({ name: 'funny' })
      .onNotification(methods.client.session.update, ({ params }) => {
        if (this.isAborted) return;
        const update = params.update;
        // History replay streams old message/tool chunks we must not re-ingest,
        // but usage_update carries the live context window size we still want.
        if (this.replayingHistory && update.sessionUpdate !== 'usage_update') return;
        this.translateUpdate(update);
      })
      .onRequest(methods.client.session.requestPermission, ({ params }) =>
        this.handleRequestPermission(params),
      )
      .connect(childAcpStream(child, ndJsonStream));
    this.connection = connection;
    const agent = connection.agent;

    try {
      const initResult = await agent.request(methods.agent.initialize, {
        protocolVersion: 1,
        clientInfo: { name: 'funny', version: '1.0.0' },
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      });

      const supportsLoadSession = initResult.agentCapabilities?.loadSession === true;
      this.supportsImages = initResult.agentCapabilities?.promptCapabilities?.image === true;
      const mcpCaps = initResult.agentCapabilities?.mcpCapabilities;
      const supportsHttp = mcpCaps?.http === true;
      const supportsSse = mcpCaps?.sse === true;

      const allMcp = toACPMcpServers(this.options.mcpServers);
      const mcpServerList = this.manifest.quirks.filterMcpByCapability
        ? allMcp.filter((s) => {
            const t = 'type' in s ? s.type : undefined;
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
          const loadResponse = await agent.request(methods.agent.session.load, {
            sessionId: this.options.sessionId!,
            cwd: this.options.cwd,
            mcpServers: mcpServerList,
          });
          // `loadSession` returns the same `configOptions` as `newSession`
          // (ACP 0.26+). Capture them here too, otherwise `applyModelSelection`
          // has no model config option to set on resume and silently falls back
          // to the provider default — losing the user's model choice on every
          // follow-up message.
          this.captureSessionConfigOptions(loadResponse?.configOptions);
        } finally {
          this.replayingHistory = false;
        }
      } else {
        const sessionResponse = await agent.request(methods.agent.session.new, {
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

      await this.applyModelSelection(agent, methods);
      await this.applyThoughtLevelSelection(agent, methods);
      await this.applySessionMode(agent, methods, isResume);

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
      connection.close();
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
  private resolveCommand(): SpawnCommand {
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
    detail: ModelFallbackDetail = {},
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
    });
  }

  /**
   * Select the requested model after session setup, per the manifest's
   * `setModel` strategy. Skips the sentinel `default` (= the provider's
   * configured default). For `modelVia: 'cli-arg'` (gemini) the model is
   * already on the launch args — nothing to do here.
   */
  private async applyModelSelection(agent: ACPAgentContext, methods: ACPMethods): Promise<void> {
    if (this.manifest.modelVia !== 'acp-method' || !this.manifest.setModel) return;
    const requestedModel = this.options.model;
    if (!requestedModel || requestedModel === 'default' || !this.activeSessionId) return;

    const declaredMethod = this.manifest.setModel.method;
    try {
      // opencode implements the raw method without advertising the capability.
      if (declaredMethod === 'session/set_model') {
        await agent.request('session/set_model', {
          sessionId: this.activeSessionId,
          modelId: requestedModel,
        });
        this.dlog.info('model selected', { via: 'session/set_model', modelId: requestedModel });
        return;
      }

      // ACP 0.26+ removed the dedicated `unstable_setSessionModel` method —
      // the model is now a `category: 'model'` session config option set via
      // `session/set_config_option`. Use it when the agent advertised one.
      if (this.modelConfigOption) {
        const { configId, valueIds } = this.modelConfigOption;
        if (valueIds.size > 0 && !valueIds.has(requestedModel)) {
          this.notifyModelFallback(
            requestedModel,
            'requested model not offered by agent — using provider default',
            { available: [...valueIds] },
          );
          return;
        }
        await agent.request(methods.agent.session.setConfigOption, {
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

      this.notifyModelFallback(
        requestedModel,
        'no model-selection method on ACP connection — using provider default',
      );
    } catch (e) {
      this.notifyModelFallback(
        requestedModel,
        'set-model failed — falling back to provider default',
        {
          // SAFETY: ACP SDK rejections are Error instances or JSON-RPC error objects
          // with `message`; the value is only logged, so a missing one is undefined.
          error: (e as Error)?.message,
        },
      );
    }
  }

  /**
   * Capture the agent's "model" and "thought level" select config options from
   * a newSession / loadSession response so {@link applyModelSelection} and
   * {@link applyThoughtLevelSelection} can apply them via
   * `setSessionConfigOption` (ACP 0.26+). Absent options are recorded as null.
   */
  private captureSessionConfigOptions(configOptions: ACPSessionConfigOptions): void {
    this.modelConfigOption = findSelectConfigOption(configOptions, 'model');
    this.thoughtLevelConfigOption = findSelectConfigOption(configOptions, 'thought_level');
  }

  private async applyThoughtLevelSelection(
    agent: ACPAgentContext,
    methods: ACPMethods,
  ): Promise<void> {
    if (!this.activeSessionId || !this.options.effort) return;
    if (!this.thoughtLevelConfigOption) return;

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
      await agent.request(methods.agent.session.setConfigOption, {
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
  private async applySessionMode(
    agent: ACPAgentContext,
    methods: ACPMethods,
    isResume: boolean,
  ): Promise<void> {
    if (this.manifest.modeVia !== 'acp-setSessionMode' || isResume || !this.activeSessionId) return;
    const funnyMode = this.options.originalPermissionMode ?? this.options.permissionMode;
    // SAFETY: `modeMap` is keyed by every PermissionMode; an unknown or missing
    // `funnyMode` indexes to undefined and returns below.
    const desiredMode = this.manifest.modeMap[funnyMode as keyof typeof this.manifest.modeMap];
    if (!desiredMode) return;
    try {
      await agent.request(methods.agent.session.setMode, {
        sessionId: this.activeSessionId,
        modeId: desiredMode,
      });
      this.dlog.info('session mode applied', { modeId: desiredMode });
    } catch (e) {
      this.emitErrorToolCall(
        `**${this.manifest.label}:** unable to switch to session mode "${desiredMode}" — ${this.extractErrorMessage(e)}`,
      );
    }
  }

  // ── Per-turn execution ──────────────────────────────────────────

  protected async runOnePrompt(prompt: string, images?: unknown[]): Promise<void> {
    if (!this.connection || !this.acpMethods || !this.activeSessionId) {
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

    try {
      const promptParams: ACPPromptRequest = {
        sessionId: this.activeSessionId,
        prompt: this.buildPromptBlocks(prompt, images),
      };
      const promptResponse = await this.connection.agent.request(
        this.acpMethods.agent.session.prompt,
        promptParams,
      );

      this.emitAcpPromptResponseUsage(promptResponse.usage);

      this.numTurns += 1;

      this.flushPendingThought();
      this.flushDeferredToolInputs();
      if (this.turnEmitCount === 0 && !this.isAborted) {
        this.emitEmptyTurnNotice(promptResponse.stopReason);
      }

      this.emitResult({
        sessionId: this.activeSessionId,
        subtype: stopReasonToSubtype(promptResponse.stopReason),
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

  private buildPromptBlocks(
    prompt: string,
    images: unknown[] | undefined,
  ): Array<{ type: 'text'; text: string } | ACPImageBlock> {
    const promptBlocks: Array<{ type: 'text'; text: string } | ACPImageBlock> = [
      { type: 'text', text: prompt },
    ];
    const imageBlocks = toACPImageBlocks(images);
    if (imageBlocks.length === 0) return promptBlocks;
    if (this.supportsImages) {
      promptBlocks.push(...imageBlocks);
    } else {
      this.dlog.warn('agent does not advertise promptCapabilities.image — dropping images', {
        count: imageBlocks.length,
      });
    }
    return promptBlocks;
  }

  /**
   * Empty-turn guard: a turn that the agent reports as completed but which
   * produced no visible output at all (no assistant text, no tool calls, no
   * thought) reads to the user as the agent silently not responding. Surface
   * it as a visible notice instead of an empty "success".
   */
  private emitEmptyTurnNotice(stopReason: string | undefined): void {
    const notice =
      `${this.manifest.label} ended the turn without producing any output ` +
      `(stopReason: ${stopReason ?? 'unknown'}) — no text, tool calls, ` +
      `or reasoning. This usually means the model was not applied or the backend ` +
      `returned nothing.`;
    this.dlog.warn('empty turn — agent produced no output', {
      stopReason,
      modelId: this.options.model,
    });
    this.emitMessage({
      type: 'assistant',
      message: { id: randomUUID(), content: [{ type: 'text', text: notice }] },
    });
    this.lastAssistantText = notice;
  }

  // ── Permission request handling ─────────────────────────────

  /**
   * Handle an ACP `session/request_permission`. The manifest's
   * `quirks.permissionModel` selects the behavior:
   *   - `auto-allow` (pi): approve every request without gating.
   *   - `gated` (default): autoEdit → allow; else consult persisted rules; else
   *     surface a synthetic pause until the run is restarted with approval.
   */
  private async handleRequestPermission(
    params: ACPRequestPermissionRequest,
  ): Promise<ACPRequestPermissionResponse> {
    const { options, toolCall } = params;

    const findOption = (kinds: string[]): string | undefined =>
      options.find((opt) => kinds.includes(opt.kind))?.optionId;

    const allowOnceOptionId =
      findOption(['allow_once']) ?? findOption(['allow_always']) ?? options[0]?.optionId ?? '';
    const rejectOptionId = findOption(['reject_once']) ?? findOption(['reject_always']);

    // auto-allow providers (pi) never gate.
    if (this.manifest.quirks.permissionModel === 'auto-allow') {
      return { outcome: { outcome: 'selected', optionId: allowOnceOptionId } };
    }

    // 1. autoEdit mode: full-bypass, never prompt.
    if (this.options.originalPermissionMode === 'autoEdit') {
      this.dlog.info('requestPermission ALLOW via autoEdit mode');
      return { outcome: { outcome: 'selected', optionId: allowOnceOptionId } };
    }

    const acpKind = toolCall.kind ?? undefined;
    const title = toolCall.title ?? '';
    const toolName = inferACPToolName(acpKind, title, undefined, toolCall);
    const toolInput = buildACPToolInput(toolName, {
      kind: acpKind,
      title,
      rawInput: toolCall.rawInput,
      locations: toolCall.locations,
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
          return { outcome: { outcome: 'selected', optionId: allowOnceOptionId } };
        }
        if (match?.decision === 'deny') {
          this.dlog.info('requestPermission DENY via persisted rule', { toolName });
          return {
            outcome: { outcome: 'selected', optionId: rejectOptionId ?? allowOnceOptionId },
          };
        }
      } catch (err) {
        this.dlog.warn('permissionRuleLookup threw — falling through', {
          toolName,
          error: String(err).slice(0, 200),
        });
      }
    }

    const toolUseId = toolCall.toolCallId ?? randomUUID();
    const denialText =
      `${this.manifest.label} requested permissions to use ${toolName} but the user hasn't been granted approval. ` +
      `Waiting for user approval.`;

    this.emitMessage(toolUseMessage(toolUseId, toolName, toolInput));
    this.emitMessage(toolResultMessage(toolUseId, denialText));

    return await new Promise<ACPRequestPermissionResponse>((resolve) => {
      const onAbort = () =>
        resolve({
          outcome: {
            outcome: 'selected',
            optionId: rejectOptionId ?? allowOnceOptionId,
          },
        });
      if (this.abortController.signal.aborted) onAbort();
      else this.abortController.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  // ── Update translation ──────────────────────────────────────

  /**
   * Emit a synthetic `tool_use` exactly once for a tool call id and mark it
   * seen. Resets the per-turn assistant-text accumulator so any following
   * agent text starts a fresh bubble.
   */
  private emitToolUse(toolCallId: string, toolName: string, input: JsonObject): void {
    this.deferredToolInputs.delete(toolCallId);
    this.toolCallsSeen.set(toolCallId, toolName);
    this.emitMessage(toolUseMessage(toolCallId, toolName, input));
    this.accumulatedText = '';
    this.assistantMsgId = randomUUID();
  }

  private emitToolResult(toolCallId: string, content: string): void {
    this.toolCallsSeen.set(toolCallId, 'done');
    this.emitMessage(toolResultMessage(toolCallId, content));
  }

  private closeInFlightTaskToolCalls(content: string): void {
    for (const [toolCallId, toolName] of this.toolCallsSeen) {
      if (toolName !== 'Task') continue;
      this.emitToolResult(toolCallId, content);
    }
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
      case 'agent_thought_chunk':
        this.handleThoughtChunk(update.content);
        return;
      case 'agent_message_chunk':
        this.handleAgentMessageChunk(update.content);
        return;
      case 'tool_call':
        this.handleToolCall(update);
        return;
      case 'tool_call_update':
        this.handleToolCallUpdate(update);
        return;
      case 'plan':
        this.handlePlan(update);
        return;
      // Built-in / dynamic slash commands the ACP agent advertises. Surface them
      // through the same `commands_changed` channel the Claude SDK uses, so the
      // send-boundary guard and the composer autocomplete see this provider's
      // commands instead of nothing. (Previously dropped on the floor.)
      case 'available_commands_update':
        this.handleAvailableCommands(update);
        return;
      // Ignore other update types (current_mode_update, etc.)
      default:
        return;
    }
  }

  private handleThoughtChunk(content: ACPContentBlock): void {
    if (content.type !== 'text' || !content.text) return;
    if (!this.pendingThought) {
      this.pendingThought = { id: randomUUID(), text: '' };
    }
    this.pendingThought.text += content.text;
  }

  private handleAgentMessageChunk(content: ACPContentBlock): void {
    this.flushPendingThought();
    if (content.type !== 'text' || !content.text) return;
    if (this.isGluedMessageBoundary(content.text)) {
      this.accumulatedText += '\n\n';
    }
    this.accumulatedText += content.text;
    // pi prefixes its agent message with a banner — strip it (data regex
    // from the manifest) so the user never sees the boilerplate. The
    // regex is anchored at ^, so stripping every emission is idempotent.
    // When the stripped text is empty (banner only, no real text yet),
    // emit nothing.
    const bannerSrc = this.manifest.quirks.stripFirstMessageBanner;
    const visible = bannerSrc ? stripBanner(this.accumulatedText, bannerSrc) : this.accumulatedText;
    if (!visible) return;
    this.emitMessage({
      type: 'assistant',
      message: {
        id: this.assistantMsgId,
        content: [{ type: 'text', text: visible }],
      },
    });
    this.lastAssistantText = visible;
  }

  /**
   * codex emits several distinct status messages within one turn as separate
   * chunks with no tool call between them; concatenating with no separator
   * produces run-ons (`…render.Aviso…`). Re-insert the dropped boundary ONLY at
   * the exact glue signature: accumulated text ends with terminal punctuation
   * and the incoming chunk starts with an uppercase letter, with no whitespace
   * at the junction. Real token streaming keeps the model's own spacing, so a
   * single streamed message never matches and is never split.
   */
  private isGluedMessageBoundary(nextText: string): boolean {
    return (
      Boolean(this.manifest.quirks.splitGluedAgentMessages) &&
      /[.!?:]$/.test(this.accumulatedText) &&
      /^\p{Lu}/u.test(nextText)
    );
  }

  /**
   * codex/gemini emit "preamble" tool_calls whose title is just
   * `[cwd …] (reason)` — narration before the next real tool. Buffer them as
   * Think text so they collapse into one Think card instead of a stack of
   * broken tool cards; the matching completion is swallowed in
   * {@link handleToolCallUpdate}. Returns true when the call was buffered.
   */
  private bufferPreambleToolCall(toolCallId: string, title: string): boolean {
    if (!this.manifest.quirks.bufferPreambleAsThink) return false;
    const preamble = parseACPPreambleTitle(title);
    if (!preamble) return false;
    if (!this.pendingThought) this.pendingThought = { id: randomUUID(), text: '' };
    this.pendingThought.text += (this.pendingThought.text ? '\n' : '') + preamble;
    this.toolCallsSeen.set(toolCallId, 'preamble');
    return true;
  }

  private handleToolCall(update: ACPToolCallUpdateLike): void {
    const toolCallId = update.toolCallId;
    const fields = readToolCallFields(update);
    if (this.bufferPreambleToolCall(toolCallId, fields.title)) return;

    this.flushPendingThought();
    if (this.toolCallsSeen.has(toolCallId)) return;

    const toolName = inferACPToolName(fields.kind, fields.title, undefined, fields);
    const input = finalizeTodoInput(toolName, buildACPToolInput(toolName, fields), update);
    const isTerminal = isTerminalToolStatus(update.status);

    if (this.deferIfUnrenderable(toolCallId, toolName, input, isTerminal)) return;

    this.emitToolUse(toolCallId, toolName, input);
    if (isTerminal) {
      const tcOutput = extractACPToolOutput(
        { rawOutput: update.rawOutput, content: fields.content },
        fields.title,
      );
      this.emitToolResult(toolCallId, tcOutput);
    }
  }

  private handleToolCallUpdate(update: ACPToolCallUpdateLike): void {
    const toolCallId = update.toolCallId;
    // Swallow the completion of a buffered preamble tool_call (codex/gemini)
    // — its text already went into the Think buffer; no stray tool_result.
    if (this.toolCallsSeen.get(toolCallId) === 'preamble') return;
    this.flushPendingThought();
    const fields = readToolCallFields(update);
    const isTerminal = isTerminalToolStatus(update.status);

    if (!this.toolCallsSeen.has(toolCallId)) {
      const done = this.handleOrphanToolCallUpdate(update, fields, isTerminal);
      if (done) return;
    }

    if (isTerminal) {
      const output = extractACPToolOutput(
        { rawOutput: update.rawOutput, content: fields.content },
        fields.title,
      );
      this.emitToolResult(toolCallId, output);
    }
  }

  /**
   * An update for a tool call we never emitted: either the agent skipped the
   * initial event, or we deferred it. Synthesize the tool_use from the richer
   * update data (only for synthToolUseFromOrphanUpdate providers). Returns true
   * when the caller must stop (no trailing tool_result emission).
   */
  private handleOrphanToolCallUpdate(
    update: ACPToolCallUpdateLike,
    fields: ACPToolCallFields,
    isTerminal: boolean,
  ): boolean {
    const toolCallId = update.toolCallId;
    if (!this.manifest.quirks.synthToolUseFromOrphanUpdate) {
      if (isTerminal) {
        const output = extractACPToolOutput(
          { rawOutput: update.rawOutput, content: fields.content },
          fields.title,
        );
        this.emitToolResult(toolCallId, output);
      }
      return true;
    }
    const buffered = this.deferredToolInputs.get(toolCallId);
    // Trust the original tool name from the deferred tool_call — an update
    // often omits kind/title, which would degrade to 'Tool'.
    const toolName =
      buffered?.name ?? inferACPToolName(fields.kind, fields.title, undefined, fields);
    const built = buildACPToolInput(toolName, fields);
    const merged = buffered ? mergeToolInput(buffered.input, built) : built;
    const input = finalizeTodoInput(toolName, merged, update);

    if (this.deferIfUnrenderable(toolCallId, toolName, input, isTerminal)) return true;

    this.emitToolUse(toolCallId, toolName, input);
    return false;
  }

  /**
   * Defer when the card isn't renderable yet (deferUnrenderableToolInput
   * providers). A non-terminal call waits for a later tool_call_update; a
   * terminal call that still lacks the field is dropped, not emitted empty.
   * Returns true when the tool call was deferred or dropped.
   */
  private deferIfUnrenderable(
    toolCallId: string,
    toolName: string,
    input: JsonObject,
    isTerminal: boolean,
  ): boolean {
    if (!this.manifest.quirks.deferUnrenderableToolInput) return false;
    if (isRenderableToolInput(toolName, input)) return false;
    if (isTerminal) {
      this.deferredToolInputs.delete(toolCallId);
    } else {
      this.deferredToolInputs.set(toolCallId, { name: toolName, input });
    }
    return true;
  }

  private handlePlan(update: ACPPlanUpdate): void {
    this.flushPendingThought();
    if (this.manifest.quirks.planRender === 'todoCard') {
      this.emitPlanAsTodoCard(update.entries);
    } else {
      this.emitPlanAsText(update.entries ?? []);
    }
  }

  private emitPlanAsTodoCard(entries: unknown[] | undefined): void {
    const input = buildTodoWriteInputFromPlanEntries(entries);
    if (input.todos.length === 0) return;
    const planText = formatPlanChecklist(input.todos.map((todo) => [todo.status, todo.content]));
    this.closeInFlightTaskToolCalls(planText);

    // ACP replaces the whole plan on each update, so each emission is its
    // own card with a fresh id — matching how the Claude SDK surfaces
    // successive TodoWrite calls.
    const toolCallId = randomUUID();
    this.emitMessage(toolUseMessage(toolCallId, 'TodoWrite', input));
    this.emitMessage(toolResultMessage(toolCallId, 'Plan updated'));
    this.accumulatedText = '';
    this.assistantMsgId = randomUUID();
  }

  /**
   * planRender 'text': render as a numbered markdown checklist under a
   * `**Plan:**` header (completed → [x], in_progress → [~], else [ ]).
   * Reuses the live assistant message id; does NOT rotate it.
   */
  private emitPlanAsText(entries: readonly PlanTextEntry[]): void {
    if (entries.length === 0) return;
    const planText = formatPlanChecklist(
      entries.map((e) => [e.status, e.content ?? e.title ?? e.description ?? 'Task']),
    );

    // codex: a `plan` arrives while a Task (switch_mode) tool_call is
    // still in flight — close it out with the rendered plan as its
    // tool_result. Harmless for providers with no open Task call.
    this.closeInFlightTaskToolCalls(planText);

    this.emitMessage({
      type: 'assistant',
      message: {
        id: this.assistantMsgId,
        content: [{ type: 'text', text: `**Plan:**\n${planText}` }],
      },
    });
  }

  private handleAvailableCommands(update: ACPUpdateOf<'available_commands_update'>): void {
    const commands = (update.availableCommands ?? [])
      .map((c) => c.name)
      .filter((n): n is string => typeof n === 'string' && n.length > 0);
    this.emitMessage({
      type: 'commands_changed',
      commands,
      sessionId: this.activeSessionId ?? '',
    });
  }
}

// ── Helpers ─────────────────────────────────────────────────────

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
      // SAFETY: gemini writes trustedFolders.json as a folder → trust-level map; if the
      // file holds something else, indexing or writing it below throws into the outer
      // catch, which only logs a warning.
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
    // SAFETY: fs and JSON errors are Error instances; the message is only logged.
    dlog.warn('failed to mark gemini trusted folder', { cwd, error: (e as Error)?.message });
  }
}
