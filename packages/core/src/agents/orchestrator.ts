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
  /** Enable Claude fast mode (higher output speed at premium pricing). Claude SDK only. */
  fastMode?: boolean;
  /**
   * Run the Claude process in persistent streaming-input mode so later prompts
   * can steer the live turn instead of respawning. Set when followUpMode ===
   * 'steer'. Claude SDK only.
   */
  steerable?: boolean;
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
  /**
   * Emitted when an idle agent is reaped (process tree terminated to free
   * memory). NON-destructive: the thread keeps its status and sessionId and
   * resumes on the next message. `idleMs` is how long it had been idle.
   */
  'agent:reaped': (threadId: string, provider: string, idleMs: number) => void;
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
  fastMode: boolean;
  /** Stable JSON of mcpServers — '' when none. */
  mcpServersKey: string;
}

function snapshotProcessOptions(opts: {
  provider?: string;
  model?: string;
  cwd?: string;
  permissionMode?: string;
  effort?: string;
  fastMode?: boolean;
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
    fastMode: opts.fastMode ?? false,
    mcpServersKey,
  };
}

/**
 * Default system-note prepended to a follow-up prompt on session resume so the
 * model continues from where it left off instead of re-planning. Used when the
 * caller doesn't supply its own `systemPrefix`.
 */
export const DEFAULT_RESUME_PREFIX =
  '[SYSTEM NOTE: This is a session resume after an interruption. Your previous session was interrupted mid-execution. Continue from where you left off. Do NOT re-plan or start over — pick up execution from the last completed step.]';

/**
 * The Claude Agent SDK only EXECUTES a slash command (e.g. `/compact`) when the
 * user message STARTS with the command. funny prepends a resume system-note to
 * follow-ups on session resume (see {@link buildEffectivePrompt}); if that note
 * lands in front of `/compact`, the SDK treats the whole message as literal text
 * and hands it to the model. The model then writes a "compacted" summary but the
 * context window is NEVER actually compacted — so no `compact_boundary` fires and
 * the context-usage counter never drops (it keeps climbing). Detect pure
 * slash-command follow-ups so they're sent verbatim.
 *
 * Guards against absolute paths (`/home/user/...`): the first token must be a
 * slash command name (letters, digits, `-`, `_`) with optional Claude namespace
 * segments separated by `:`, and no further slash.
 */
export function isPureSlashCommand(prompt: string): boolean {
  return /^\/[a-zA-Z][\w-]*(?::[a-zA-Z][\w-]*)*(?:\s|$)/.test(prompt.trimStart());
}

/**
 * Extract the command name (without the leading slash) from a pure slash-command
 * prompt — e.g. `"/compact keep notes"` → `"compact"`. Returns `null` when the
 * prompt isn't a pure slash command. Used at the send boundary to validate the
 * command against the SDK-reported list before forwarding.
 */
export function extractSlashCommandName(prompt: string): string | null {
  const m = /^\/([a-zA-Z][\w-]*(?::[a-zA-Z][\w-]*)*)(?:\s|$)/.exec(prompt.trimStart());
  return m ? m[1] : null;
}

/**
 * Build the prompt actually sent to the agent on (re)start. On session resume we
 * prepend a system-note so the model continues instead of re-planning — EXCEPT
 * for slash commands, which must reach the SDK verbatim to be executed (see
 * {@link isPureSlashCommand}).
 */
export function buildEffectivePrompt(
  prompt: string,
  opts: { isResume: boolean; resumePrefix?: string },
): string {
  if (!opts.isResume || isPureSlashCommand(prompt)) return prompt;
  const prefix = opts.resumePrefix ?? DEFAULT_RESUME_PREFIX;
  return `${prefix}\n\n${prompt}`;
}

// ── Orchestrator ──────────────────────────────────────────────────

/**
 * Idle windows (ms) for {@link AgentOrchestrator.getIdleCandidates}. `claude`
 * uses `claudeIdleMs`; every other provider uses `defaultIdleMs`. `0` (or less)
 * disables reaping for that class.
 */
export interface IdleReapPolicy {
  defaultIdleMs: number;
  claudeIdleMs: number;
}

export class AgentOrchestrator extends EventEmitter {
  private activeAgents = new Map<string, IAgentProcess>();
  private resultReceived = new Set<string>();
  private manuallyStopped = new WeakSet<IAgentProcess>();
  /**
   * Last process options applied per thread, used to gate process reuse.
   * Reusing via `sendPrompt()` is only safe when the new request matches
   * the live process on provider, model, cwd, permissionMode, effort, and
   * mcpServers — anything else implies the user changed something that
   * the live agent can't reflect, so we kill + respawn instead.
   */
  private lastOptions = new Map<string, ProcessOptionsSnapshot>();

  /**
   * Wall-clock ms of the most recent agent activity per thread — refreshed on
   * start/adopt, on every emitted message, and on `sendPrompt`/`steerPrompt`
   * reuse. A mid-turn process emits messages continuously, so its timestamp
   * stays fresh and it is structurally ineligible for idle reaping.
   */
  private lastActivityAt = new Map<string, number>();

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
    if (prev.fastMode !== next.fastMode) return false;
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
      fastMode,
      steerable,
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
      fastMode,
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
      !this.manuallyStopped.has(existing) &&
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
        this.lastActivityAt.set(threadId, Date.now());
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
        this.lastActivityAt.set(threadId, Date.now());
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
      this.manuallyStopped.add(existing);
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

    // Build effective prompt for session resume. buildEffectivePrompt skips the
    // resume system-note for slash commands so e.g. "/compact" reaches the SDK
    // verbatim and actually compacts (see isPureSlashCommand / buildEffectivePrompt).
    if (isResume) {
      dlog.info('Resuming session with sessionId', {
        threadId,
        sessionId,
        slashCommand: isPureSlashCommand(prompt),
      });
    }
    const effectivePrompt = buildEffectivePrompt(prompt, {
      isResume,
      resumePrefix: systemPrefix,
    });

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
      fastMode,
      steerable,
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
      this.manuallyStopped.add(proc);
      try {
        await proc.kill();
      } catch (e) {
        dlog.error('Error killing process', { threadId, error: String(e).slice(0, 200) });
      }
      this.activeAgents.delete(threadId);
    }
    this.lastOptions.delete(threadId);
    this.lastActivityAt.delete(threadId);
    this.emit('agent:stopped', threadId);
  }

  isRunning(threadId: string): boolean {
    return this.activeAgents.has(threadId);
  }

  /**
   * Select threads whose live agent process is idle enough to reap.
   *
   * A candidate must be quiescent and turn-terminal: `resultReceived` is the
   * gate — it is set only when the current turn produces a `result` and stays
   * true while the process idles awaiting a follow-up. A mid-turn process (no
   * result yet) and a process paused on a permission prompt (no result yet)
   * are both excluded automatically.
   *
   * Provider policy is binary, mirroring the cold-path resume rule: `claude`
   * uses `claudeIdleMs`, every other provider uses `defaultIdleMs`. A window of
   * `0` (or less) disables reaping for that class. Pure over current state —
   * `nowMs` is injected so callers (and tests) control the clock.
   */
  getIdleCandidates(nowMs: number, policy: IdleReapPolicy): string[] {
    const out: string[] = [];
    for (const [threadId, proc] of this.activeAgents) {
      if (proc.exited) continue;
      if (!this.resultReceived.has(threadId)) continue; // mid-turn or awaiting permission
      const provider = this.lastOptions.get(threadId)?.provider ?? '';
      const idleMs = provider === 'claude' ? policy.claudeIdleMs : policy.defaultIdleMs;
      if (idleMs <= 0) continue; // disabled for this class
      const last = this.lastActivityAt.get(threadId);
      if (last === undefined) continue;
      if (nowMs - last > idleMs) out.push(threadId);
    }
    return out;
  }

  /**
   * Reap an idle agent: terminate its process tree and drop in-memory state.
   *
   * Distinct from {@link stopAgent} — reaping is NON-destructive: it does NOT
   * mark the thread manually stopped, does NOT clear the persisted sessionId,
   * and does NOT change thread status. The next user message resumes the thread
   * through the existing resume / cold-path flow. Emits `agent:reaped` so the
   * runtime can log/meter it without treating it as a stop.
   */
  async reapIdleAgent(threadId: string): Promise<void> {
    const proc = this.activeAgents.get(threadId);
    if (!proc) return;
    const provider = this.lastOptions.get(threadId)?.provider ?? '';
    const last = this.lastActivityAt.get(threadId);
    const idleMs = last !== undefined ? Date.now() - last : 0;

    try {
      await proc.kill();
    } catch (e) {
      dlog.error('Error reaping idle agent', { threadId, error: String(e).slice(0, 200) });
    }

    // Only remove if THIS proc is still the active one (the exit handler may
    // race us). resultReceived is true here, so the exit handler will not
    // emit agent:unexpected-exit.
    if (this.activeAgents.get(threadId) === proc) {
      this.activeAgents.delete(threadId);
      this.lastOptions.delete(threadId);
    }
    this.lastActivityAt.delete(threadId);
    this.resultReceived.delete(threadId);

    this.emit('agent:reaped', threadId, provider, idleMs);
  }

  /**
   * Clean up all in-memory state for a thread.
   * Call when deleting/archiving a thread.
   */
  cleanupThread(threadId: string): void {
    const proc = this.activeAgents.get(threadId);
    if (proc) this.manuallyStopped.delete(proc);
    this.activeAgents.delete(threadId);
    this.resultReceived.delete(threadId);
    this.lastOptions.delete(threadId);
    this.lastActivityAt.delete(threadId);
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
    this.lastOptions.clear();
    this.lastActivityAt.clear();
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
    // Seed activity on start/adopt so a freshly wired (or adopted-after-restart)
    // process is never reaped on the next sweep.
    this.lastActivityAt.set(threadId, Date.now());

    proc.on('message', (msg: CLIMessage) => {
      if (this.activeAgents.get(threadId) !== proc) {
        dlog.debug('Ignoring message from stale process', { threadId, type: msg.type });
        return;
      }
      if (this.manuallyStopped.has(proc)) {
        dlog.debug('Suppressing message for manually stopped agent', { threadId, type: msg.type });
        return;
      }
      this.lastActivityAt.set(threadId, Date.now());
      dlog.debug('wireProcessHandlers message', {
        threadId,
        type: msg.type,
        subtype: (msg as any).subtype,
      });
      if (msg.type === 'result') {
        this.resultReceived.add(threadId);
      }
      this.emit('agent:message', threadId, msg);
    });

    proc.on('error', (err: Error) => {
      if (this.activeAgents.get(threadId) !== proc) {
        dlog.debug('Ignoring error from stale process', { threadId });
        return;
      }
      if (this.manuallyStopped.has(proc)) {
        dlog.debug('Suppressing error for manually stopped agent', { threadId });
        return;
      }
      dlog.error('Process error', { threadId, error: String(err).slice(0, 200) });
      if (!this.resultReceived.has(threadId)) {
        this.emit('agent:error', threadId, err);
      }
    });

    proc.on('session-invalidated', () => {
      dlog.warn('Process reported invalidated session — clearing sessionId', { threadId });
      this.emit('agent:session-cleared', threadId);
    });

    proc.on('exit', (code: number | null) => {
      const isActiveProcess = this.activeAgents.get(threadId) === proc;
      const wasManuallyStopped = this.manuallyStopped.has(proc);
      dlog.info('Process exit', {
        threadId,
        code,
        hadResult: this.resultReceived.has(threadId),
        manuallyStopped: wasManuallyStopped,
        staleProcess: !isActiveProcess,
      });
      // Only remove if THIS proc is still the active one — a newer process
      // may already have replaced it in the map (race during kill + restart).
      if (isActiveProcess) {
        this.activeAgents.delete(threadId);
        this.lastOptions.delete(threadId);
        this.lastActivityAt.delete(threadId);
      }

      if (!isActiveProcess) {
        this.manuallyStopped.delete(proc);
        dlog.debug('Ignoring exit from stale process', { threadId, code });
        return;
      }

      if (wasManuallyStopped) {
        this.manuallyStopped.delete(proc);
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
    this.lastActivityAt.set(threadId, Date.now());

    let gotMessage = false;
    let immediateError = false;

    proc.on('message', (msg: CLIMessage) => {
      if (this.activeAgents.get(threadId) !== proc) {
        dlog.debug('Ignoring resume message from stale process', { threadId, type: msg.type });
        return;
      }
      if (this.manuallyStopped.has(proc)) {
        dlog.debug('Suppressing resume message for manually stopped agent', {
          threadId,
          type: msg.type,
        });
        return;
      }
      gotMessage = true;
      this.lastActivityAt.set(threadId, Date.now());
      dlog.debug('wireResumeHandlers message', {
        threadId,
        type: msg.type,
        subtype: (msg as any).subtype,
        firstMessage: !gotMessage,
      });
      if (msg.type === 'result') {
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

    proc.on('session-invalidated', () => {
      dlog.warn('Resume process reported invalidated session — clearing sessionId', { threadId });
      this.emit('agent:session-cleared', threadId);
    });

    proc.on('error', (err: Error) => {
      if (this.activeAgents.get(threadId) !== proc) {
        dlog.debug('Ignoring resume error from stale process', { threadId });
        return;
      }
      if (this.manuallyStopped.has(proc)) {
        dlog.debug('Suppressing resume error for manually stopped agent', { threadId });
        return;
      }
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
      if (!this.resultReceived.has(threadId)) {
        this.emit('agent:error', threadId, err);
      }
    });

    proc.on('exit', (code: number | null) => {
      const isActiveProcess = this.activeAgents.get(threadId) === proc;
      const wasManuallyStopped = this.manuallyStopped.has(proc);
      dlog.info('Resume process exit', {
        threadId,
        code,
        gotMessage,
        immediateError,
        hadResult: this.resultReceived.has(threadId),
        manuallyStopped: wasManuallyStopped,
        staleProcess: !isActiveProcess,
      });
      // Only remove if THIS proc is still the active one — a newer process
      // may already have replaced it in the map (race during kill + restart).
      if (isActiveProcess) {
        this.activeAgents.delete(threadId);
        this.lastOptions.delete(threadId);
        this.lastActivityAt.delete(threadId);
      }

      if (!isActiveProcess) {
        this.manuallyStopped.delete(proc);
        dlog.debug('Ignoring resume exit from stale process', { threadId, code });
        return;
      }

      if (wasManuallyStopped) {
        this.manuallyStopped.delete(proc);
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
