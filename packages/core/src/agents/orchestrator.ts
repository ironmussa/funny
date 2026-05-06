/**
 * AgentOrchestrator — portable agent lifecycle manager.
 *
 * Owns process creation, start/stop/resume, and lifecycle events.
 * Does NOT touch DB, WebSocket, or any server infrastructure.
 * Consumers subscribe to events for persistence / broadcasting.
 */

import { EventEmitter } from 'events';

import type { AgentProvider, AgentModel, PermissionMode } from '@funny/shared';

import { createDebugLogger } from '../debug.js';

const dlog = createDebugLogger('orch');
import {
  resolveModelId,
  resolvePermissionMode,
  resolveResumePermissionMode,
  getDefaultAllowedTools,
  getAskModeTools,
} from '@funny/shared/models';

import type { IAgentProcess, IAgentProcessFactory } from './interfaces.js';
import type { CLIMessage } from './types.js';

// ── Types ─────────────────────────────────────────────────────────

export interface StartAgentOptions {
  threadId: string;
  prompt: string;
  cwd: string;
  model?: AgentModel;
  permissionMode?: PermissionMode;
  images?: any[];
  disallowedTools?: string[];
  allowedTools?: string[];
  provider?: AgentProvider;
  /** Session ID for resume — caller reads this from their storage. */
  sessionId?: string;
  maxTurns?: number;
  /** MCP servers to pass to the agent process (e.g., CDP browser tools) */
  mcpServers?: Record<string, any>;
  /** Custom spawn function for sandboxed execution (e.g., Podman container) */
  spawnClaudeCodeProcess?: (options: any) => any;
  /** Custom system prefix for resume — replaces the default "interrupted session" note. */
  systemPrefix?: string;
  /** Additional environment variables to pass to the agent subprocess (e.g., API keys). */
  env?: Record<string, string>;
  /** Effort level for Claude SDK — controls thinking depth ('low' | 'medium' | 'high' | 'xhigh' | 'max') */
  effort?: string;
  /** Built-in skill names to disable (Deep Agent only) */
  builtinSkillsDisabled?: string[];
  /** Additional skill directory paths (Deep Agent only) */
  customSkillPaths?: string[];
  /** Custom agent name (Deep Agent only) */
  agentName?: string;
  /**
   * Lookup callback for persisted "always allow / always deny" permission
   * rules. Forwarded to the agent process so the preToolUseHook can
   * short-circuit on a matching rule without prompting the user. See
   * `ClaudeProcessOptions.permissionRuleLookup`.
   */
  permissionRuleLookup?: (query: {
    toolName: string;
    toolInput?: string;
  }) => Promise<{ decision: 'allow' | 'deny' } | null>;
  /**
   * Bypass executor for sensitive-path operations whose rule resolves to
   * "allow". See `ClaudeProcessOptions.bypassExecutor` for the rationale.
   */
  bypassExecutor?: (query: {
    toolName: string;
    toolInput: unknown;
    cwd?: string;
  }) => Promise<{ output: string } | null>;
  /**
   * Steer mode: cancel the in-flight turn before sending the prompt.
   * Requires a live, compatible process that implements `steerPrompt`.
   * Falls back to plain follow-up (sendPrompt) when the live process
   * doesn't support steering or options changed; never falls through
   * to kill+respawn so the cancelled turn's partial output is preserved.
   */
  steer?: boolean;
}

export interface OrchestratorEvents {
  'agent:started': (threadId: string) => void;
  'agent:message': (threadId: string, msg: CLIMessage) => void;
  'agent:error': (threadId: string, error: Error) => void;
  'agent:stopped': (threadId: string) => void;
  'agent:unexpected-exit': (threadId: string, code: number | null) => void;
  /** Emitted when a session resume fails and the session ID is discarded. */
  'agent:session-cleared': (threadId: string) => void;
}

/**
 * Subset of process options compared to decide whether a follow-up prompt
 * can be issued on a live process via `sendPrompt()` instead of respawning.
 */
interface ProcessOptionsSnapshot {
  provider: string;
  model: string;
  cwd: string;
  permissionMode: string;
  effort?: string;
  /** Stable JSON of mcpServers — '' when none. */
  mcpServersKey: string;
}

function snapshotProcessOptions(opts: {
  provider?: string;
  model?: string;
  cwd?: string;
  permissionMode?: string;
  effort?: string;
  mcpServers?: Record<string, any>;
}): ProcessOptionsSnapshot {
  let mcpServersKey = '';
  if (opts.mcpServers) {
    try {
      const sortedKeys = Object.keys(opts.mcpServers).sort();
      const sorted: Record<string, any> = {};
      for (const k of sortedKeys) sorted[k] = opts.mcpServers[k];
      mcpServersKey = JSON.stringify(sorted);
    } catch {
      mcpServersKey = '__unstable__';
    }
  }
  return {
    provider: opts.provider ?? '',
    model: opts.model ?? '',
    cwd: opts.cwd ?? '',
    permissionMode: opts.permissionMode ?? '',
    effort: opts.effort,
    mcpServersKey,
  };
}

// ── Orchestrator ──────────────────────────────────────────────────

export class AgentOrchestrator extends EventEmitter {
  private activeAgents = new Map<string, IAgentProcess>();
  private resultReceived = new Set<string>();
  private manuallyStopped = new Set<string>();
  /**
   * Last process options applied per thread, used to gate process reuse.
   * Reusing via `sendPrompt()` is only safe when the new request matches
   * the live process on provider, model, cwd, permissionMode, effort, and
   * mcpServers — anything else implies the user changed something that
   * the live agent can't reflect, so we kill + respawn instead.
   */
  private lastOptions = new Map<string, ProcessOptionsSnapshot>();

  constructor(private processFactory: IAgentProcessFactory) {
    super();
  }

  /** Compare the subset of options that gate process reuse. */
  private isCompatibleOptions(
    prev: ProcessOptionsSnapshot | undefined,
    next: ProcessOptionsSnapshot,
  ): boolean {
    if (!prev) return false;
    if (prev.provider !== next.provider) return false;
    if (prev.model !== next.model) return false;
    if (prev.cwd !== next.cwd) return false;
    if (prev.permissionMode !== next.permissionMode) return false;
    if (prev.effort !== next.effort) return false;
    if (prev.mcpServersKey !== next.mcpServersKey) return false;
    return true;
  }

  // ── Public API ────────────────────────────────────────────────

  async startAgent(options: StartAgentOptions): Promise<void> {
    const {
      threadId,
      prompt,
      cwd,
      model = 'sonnet',
      permissionMode = 'autoEdit',
      images,
      disallowedTools,
      allowedTools,
      provider = 'claude',
      sessionId,
      maxTurns = 200,
      mcpServers,
      spawnClaudeCodeProcess,
      systemPrefix,
      env,
      effort,
      builtinSkillsDisabled,
      customSkillPaths,
      agentName,
      permissionRuleLookup,
      bypassExecutor,
      steer,
    } = options;

    dlog.info('startAgent', {
      threadId,
      provider,
      model,
      cwd,
      hasSessionId: !!sessionId,
      permissionMode,
      imageCount: Array.isArray(images) ? images.length : 0,
    });

    const isResume = !!sessionId;
    const nextSnapshot = snapshotProcessOptions({
      provider,
      model,
      cwd,
      permissionMode,
      effort,
      mcpServers,
    });

    // Reuse gate: if a live process supports sendPrompt and the request is
    // compatible, issue the follow-up on the live process instead of killing
    // + respawning. Keeps the in-memory ACP session warm and avoids
    // loadSession replay (which on gemini-cli re-emits prior assistant
    // messages and tool calls as new updates, duplicating them in the DB).
    // The persisted sessionId in `options.sessionId` is just a reflection
    // of what this same live process emitted via system:init — it does not
    // imply the process is gone. After a watcher restart, `lastOptions` is
    // cleared by extractActiveAgents, so isCompatibleOptions returns false
    // and we fall through to the kill+respawn loadSession path.
    const existing = this.activeAgents.get(threadId);
    const liveAndCompatible =
      existing &&
      !existing.exited &&
      !this.manuallyStopped.has(threadId) &&
      this.isCompatibleOptions(this.lastOptions.get(threadId), nextSnapshot);

    // Steer path: cancel the in-flight turn, then queue the new prompt on
    // the same session. Requires steerPrompt — if the adapter doesn't
    // implement it (or steerPrompt throws), fall through to the regular
    // sendPrompt reuse path. Never falls through to kill+respawn because
    // that would discard the cancelled turn's partial output.
    if (steer && liveAndCompatible && typeof existing!.steerPrompt === 'function') {
      dlog.info('Steering live agent process', { threadId, provider });
      try {
        await existing!.steerPrompt!(prompt, images);
        this.lastOptions.set(threadId, nextSnapshot);
        this.emit('agent:started', threadId);
        return;
      } catch (e) {
        dlog.warn('steerPrompt failed — falling back to sendPrompt', {
          threadId,
          error: String(e).slice(0, 200),
        });
        // Fall through to sendPrompt reuse below.
      }
    }

    if (liveAndCompatible && typeof existing!.sendPrompt === 'function') {
      dlog.info('Reusing live agent process via sendPrompt', { threadId, provider });
      try {
        await existing!.sendPrompt(prompt, images);
        this.lastOptions.set(threadId, nextSnapshot);
        this.emit('agent:started', threadId);
        return;
      } catch (e) {
        dlog.warn('sendPrompt on live process failed — falling back to respawn', {
          threadId,
          error: String(e).slice(0, 200),
        });
        // Fall through to kill + respawn.
      }
    }

    // Kill existing process if still running
    if (existing && !existing.exited) {
      dlog.info('Stopping existing agent before restart', { threadId });
      this.manuallyStopped.add(threadId);
      try {
        await existing.kill();
      } catch {
        /* best-effort */
      }
      this.activeAgents.delete(threadId);
    }

    // Clear stale state
    this.resultReceived.delete(threadId);
    this.lastOptions.delete(threadId);

    // Build effective prompt for session resume
    let effectivePrompt = prompt;
    if (isResume) {
      dlog.info('Resuming session with sessionId', { threadId, sessionId });
      const prefix =
        systemPrefix ??
        `[SYSTEM NOTE: This is a session resume after an interruption. Your previous session was interrupted mid-execution. Continue from where you left off. Do NOT re-plan or start over — pick up execution from the last completed step.]`;
      effectivePrompt = `${prefix}\n\n${prompt}`;
    }

    // Resolve model ID and permission mode via registry
    const resolvedModel = resolveModelId(provider, model);
    const effectivePermissionMode = resolvePermissionMode(provider, permissionMode);

    // Build shared process options
    // In ask mode, restrict to read-only tools regardless of caller-provided lists
    const isAskMode = permissionMode === 'ask';
    const effectiveAllowedTools = isAskMode
      ? getAskModeTools()
      : (allowedTools ?? getDefaultAllowedTools(provider));
    const effectiveDisallowedTools = isAskMode
      ? ['Edit', 'Write', 'Bash', 'NotebookEdit', 'TodoWrite']
      : disallowedTools;
    const processOpts = {
      threadId,
      prompt: effectivePrompt,
      cwd,
      model: resolvedModel,
      permissionMode: effectivePermissionMode,
      originalPermissionMode: permissionMode,
      allowedTools: effectiveAllowedTools,
      disallowedTools: effectiveDisallowedTools,
      maxTurns,
      images,
      provider,
      mcpServers,
      spawnClaudeCodeProcess,
      systemPrefix,
      env,
      effort,
      builtinSkillsDisabled,
      customSkillPaths,
      agentName,
      permissionRuleLookup,
      bypassExecutor,
    };

    dlog.info('processOpts systemPrefix', {
      threadId,
      hasSystemPrefix: !!systemPrefix,
      systemPrefixLength: systemPrefix?.length ?? 0,
      isResume,
    });

    if (isResume) {
      // Downgrade plan → acceptEdits on resume so the agent can actually
      // execute after the user approved the plan.  Without this, the resumed
      // session stays in plan mode and immediately calls ExitPlanMode again.
      const resumePermission = resolveResumePermissionMode(provider, processOpts.permissionMode);
      if (resumePermission !== processOpts.permissionMode) {
        dlog.info('Downgrading permissionMode for resume', {
          threadId,
          from: processOpts.permissionMode,
          to: resumePermission,
        });
        processOpts.permissionMode = resumePermission;
      }
      dlog.info('Starting agent with session resume', { threadId, sessionId });
      this.startWithResume(threadId, processOpts, sessionId!);
    } else {
      dlog.info('Starting agent fresh (no sessionId)', { threadId });
      this.startFresh(threadId, processOpts, sessionId);
    }

    // Record the snapshot so the next follow-up can decide whether to reuse
    // the live process via sendPrompt. Saved after start* returns — startFresh
    // throws on spawn failure, in which case we leave lastOptions cleared.
    this.lastOptions.set(threadId, nextSnapshot);
  }

  async stopAgent(threadId: string): Promise<void> {
    const proc = this.activeAgents.get(threadId);
    if (proc) {
      this.manuallyStopped.add(threadId);
      try {
        await proc.kill();
      } catch (e) {
        dlog.error('Error killing process', { threadId, error: String(e).slice(0, 200) });
      }
      this.activeAgents.delete(threadId);
    }
    this.lastOptions.delete(threadId);
    this.emit('agent:stopped', threadId);
  }

  isRunning(threadId: string): boolean {
    return this.activeAgents.has(threadId);
  }

  /**
   * Clean up all in-memory state for a thread.
   * Call when deleting/archiving a thread.
   */
  cleanupThread(threadId: string): void {
    this.activeAgents.delete(threadId);
    this.resultReceived.delete(threadId);
    this.manuallyStopped.delete(threadId);
    this.lastOptions.delete(threadId);
  }

  /**
   * Extract active agent processes WITHOUT killing them.
   * Used to preserve agents across bun --watch restarts.
   * Returns the current active agents and clears internal state.
   */
  extractActiveAgents(): Map<string, IAgentProcess> {
    const agents = new Map(this.activeAgents);
    // Detach: remove all our listeners so the old orchestrator
    // doesn't interfere when these processes emit events.
    for (const [, proc] of agents) {
      proc.removeAllListeners();
    }
    this.activeAgents.clear();
    this.resultReceived.clear();
    this.manuallyStopped.clear();
    this.lastOptions.clear();
    return agents;
  }

  /**
   * Adopt a surviving agent process (from a previous module evaluation).
   * Wires fresh event handlers so messages flow to the new DB + WebSocket.
   */
  adoptProcess(threadId: string, proc: IAgentProcess): void {
    this.wireProcessHandlers(proc, threadId);
    dlog.info('Adopted surviving agent', { threadId });
  }

  /**
   * Kill all active agent processes.
   */
  async stopAll(): Promise<void> {
    const entries = [...this.activeAgents.entries()];
    if (entries.length === 0) return;
    dlog.info('Stopping all agents', { count: entries.length });
    await Promise.allSettled(
      entries.map(async ([threadId, proc]) => {
        try {
          await proc.kill();
        } catch (e) {
          dlog.error('Error killing agent', { threadId, error: String(e).slice(0, 200) });
        }
        this.activeAgents.delete(threadId);
        this.lastOptions.delete(threadId);
      }),
    );
    dlog.info('All agents stopped');
  }

  // ── Process wiring ─────────────────────────────────────────────

  /**
   * Wire the standard message/error/exit handlers to a process.
   * Used for both fresh starts and as a fallback after failed resume.
   */
  private wireProcessHandlers(proc: IAgentProcess, threadId: string): void {
    this.activeAgents.set(threadId, proc);
    this.resultReceived.delete(threadId);

    proc.on('message', (msg: CLIMessage) => {
      dlog.debug('wireProcessHandlers message', {
        threadId,
        type: msg.type,
        subtype: (msg as any).subtype,
      });
      if (msg.type === 'result') {
        if (this.manuallyStopped.has(threadId)) {
          dlog.debug('Suppressing result for manually stopped agent', { threadId });
          return;
        }
        this.resultReceived.add(threadId);
      }
      this.emit('agent:message', threadId, msg);
    });

    proc.on('error', (err: Error) => {
      dlog.error('Process error', { threadId, error: String(err).slice(0, 200) });
      if (!this.resultReceived.has(threadId) && !this.manuallyStopped.has(threadId)) {
        this.emit('agent:error', threadId, err);
      }
    });

    proc.on('exit', (code: number | null) => {
      dlog.info('Process exit', {
        threadId,
        code,
        hadResult: this.resultReceived.has(threadId),
        manuallyStopped: this.manuallyStopped.has(threadId),
      });
      // Only remove if THIS proc is still the active one — a newer process
      // may already have replaced it in the map (race during kill + restart).
      if (this.activeAgents.get(threadId) === proc) {
        this.activeAgents.delete(threadId);
        this.lastOptions.delete(threadId);
      }

      if (this.manuallyStopped.has(threadId)) {
        this.manuallyStopped.delete(threadId);
        this.resultReceived.delete(threadId);
        return;
      }

      if (!this.resultReceived.has(threadId)) {
        dlog.warn('Unexpected exit (no result received)', { threadId, code });
        this.emit('agent:unexpected-exit', threadId, code);
      }

      // Defer cleanup so the error handler can still check resultReceived
      // if an error event fires shortly after exit (e.g., container teardown).
      setTimeout(() => this.resultReceived.delete(threadId), 1000);
    });
  }

  /**
   * Wire resume-aware handlers that detect stale sessions and auto-retry.
   * If the process exits without ever producing a message, falls back
   * to a fresh session via `onStaleSession`.
   */
  private wireResumeHandlers(
    proc: IAgentProcess,
    threadId: string,
    onStaleSession: () => void,
    onImmediateError?: () => void,
  ): void {
    this.activeAgents.set(threadId, proc);
    this.resultReceived.delete(threadId);

    let gotMessage = false;
    let immediateError = false;

    proc.on('message', (msg: CLIMessage) => {
      gotMessage = true;
      dlog.debug('wireResumeHandlers message', {
        threadId,
        type: msg.type,
        subtype: (msg as any).subtype,
        firstMessage: !gotMessage,
      });
      if (msg.type === 'result') {
        if (this.manuallyStopped.has(threadId)) return;

        // Detect immediate session failure: the CLI started, but produced an
        // error result with 0 turns — the session was recognised but the
        // working directory (or some other env) changed so it crashed right
        // away. Treat this the same as a stale session so we can retry fresh.
        const r = msg as any;
        if (
          r.subtype === 'error_during_execution' &&
          (r.num_turns === 0 || r.num_turns === undefined)
        ) {
          dlog.warn(
            'Resume produced immediate error result (0 turns) — treating as stale session',
            {
              threadId,
              subtype: r.subtype,
              numTurns: r.num_turns,
            },
          );
          immediateError = true;
          // Do NOT mark resultReceived — let exit handler trigger recovery
          return;
        }

        this.resultReceived.add(threadId);
      }
      this.emit('agent:message', threadId, msg);
    });

    proc.on('error', (err: Error) => {
      if (!gotMessage || immediateError) {
        dlog.warn('Resume error before any message (stale session?)', {
          threadId,
          error: String(err).slice(0, 200),
        });
        return;
      }
      dlog.error('Resume process error (after messages)', {
        threadId,
        error: String(err).slice(0, 200),
      });
      if (!this.resultReceived.has(threadId) && !this.manuallyStopped.has(threadId)) {
        this.emit('agent:error', threadId, err);
      }
    });

    proc.on('exit', (code: number | null) => {
      dlog.info('Resume process exit', {
        threadId,
        code,
        gotMessage,
        immediateError,
        hadResult: this.resultReceived.has(threadId),
      });
      // Only remove if THIS proc is still the active one — a newer process
      // may already have replaced it in the map (race during kill + restart).
      if (this.activeAgents.get(threadId) === proc) {
        this.activeAgents.delete(threadId);
        this.lastOptions.delete(threadId);
      }

      if (this.manuallyStopped.has(threadId)) {
        this.manuallyStopped.delete(threadId);
        this.resultReceived.delete(threadId);
        return;
      }

      if (!gotMessage) {
        dlog.warn('Stale session detected — retrying fresh', { threadId, code });
        onStaleSession();
        return;
      }

      if (immediateError) {
        dlog.warn('Immediate error during resume — failing with recovery flag', {
          threadId,
          code,
        });
        (onImmediateError ?? onStaleSession)();
        return;
      }

      if (!this.resultReceived.has(threadId)) {
        dlog.warn('Resume unexpected exit (no result)', { threadId, code });
        this.emit('agent:unexpected-exit', threadId, code);
      }
      setTimeout(() => this.resultReceived.delete(threadId), 1000);
    });
  }

  // ── Start strategies ───────────────────────────────────────────

  /** Start a fresh (non-resume) agent process. */
  private startFresh(threadId: string, processOpts: Record<string, any>, sessionId?: string): void {
    dlog.info('startFresh', { threadId, hasSessionId: !!sessionId });
    const proc = this.processFactory.create({ ...processOpts, sessionId } as any);
    this.wireProcessHandlers(proc, threadId);

    try {
      proc.start();
      this.emit('agent:started', threadId);
    } catch (err) {
      dlog.error('startFresh failed', { threadId, error: String(err).slice(0, 200) });
      this.activeAgents.delete(threadId);
      throw err;
    }
  }

  /**
   * Start a resume agent process with auto-retry on stale session.
   * If the session is stale (crashes before producing any output),
   * transparently falls back to a fresh session.
   */
  private startWithResume(
    threadId: string,
    processOpts: Record<string, any>,
    sessionId: string,
  ): void {
    const resumeProc = this.processFactory.create({ ...processOpts, sessionId } as any);

    const retryFresh = () => {
      dlog.warn('Resume failed, retrying without session', { threadId, sessionId });
      this.emit('agent:session-cleared', threadId);

      const freshProc = this.processFactory.create({ ...processOpts, sessionId: undefined } as any);
      this.wireProcessHandlers(freshProc, threadId);

      try {
        freshProc.start();
      } catch (freshErr) {
        this.activeAgents.delete(threadId);
        this.emit(
          'agent:error',
          threadId,
          freshErr instanceof Error ? freshErr : new Error(String(freshErr)),
        );
      }
    };

    // When the session produces an immediate error result (0 turns), the
    // prompt doesn't contain the conversation history — retrying fresh
    // immediately would lose context. Instead, clear the session and let
    // the thread fail; the next user message will trigger context recovery
    // via buildThreadContext which injects the full conversation.
    const failWithRecovery = () => {
      dlog.warn('Resume produced immediate error — failing with context recovery flag', {
        threadId,
        sessionId,
      });
      this.emit('agent:session-cleared', threadId);
      this.emit(
        'agent:error',
        threadId,
        new Error(
          'Session resume failed (0 turns). Re-send your message to continue with full conversation context.',
        ),
      );
    };

    this.wireResumeHandlers(resumeProc, threadId, retryFresh, failWithRecovery);

    try {
      resumeProc.start();
      this.emit('agent:started', threadId);
    } catch {
      retryFresh();
    }
  }
}
