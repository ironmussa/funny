/**
 * SDKClaudeProcess — adapter that wraps @anthropic-ai/claude-agent-sdk query()
 * behind the IAgentProcess EventEmitter interface.
 *
 * Drop-in replacement for the former ClaudeProcess (CLI subprocess).
 * AgentRunner and AgentMessageHandler work unchanged.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage, HookCallback, Query } from '@anthropic-ai/claude-agent-sdk';

import { createDebugLogger } from '../debug.js';
import { BaseAgentProcess } from './base-process.js';
import { resolveSDKCliPath } from './resolve-sdk-cli.js';
import type { CLIMessage } from './types.js';

const dlog = createDebugLogger('sdk');

export class SDKClaudeProcess extends BaseAgentProcess {
  private activeQuery: Query | null = null;
  private stderrBuffer: string[] = [];

  // ── Overrides ──────────────────────────────────────────────────

  async kill(): Promise<void> {
    dlog.debug('kill() called', { hasActiveQuery: !!this.activeQuery });
    await super.kill();
    // close() forcefully ends the query, stopping all in-flight API calls
    // and preventing further messages from being yielded
    this.activeQuery?.close();
  }

  // ── Provider-specific run loop ─────────────────────────────────

  protected async runProcess(): Promise<void> {
    const promptInput = this.buildPromptInput();

    // Increase API_TIMEOUT_MS so interactive hooks (AskUserQuestion, ExitPlanMode)
    // don't get killed by the default 600s HTTP timeout while waiting for user input.
    // 4 hours = 14_400_000ms — enough for any realistic user response time.
    // Strip CLAUDECODE to prevent "nested session" detection when the runner
    // itself runs inside a Claude Code terminal or after a previous query()
    // mutated process.env. Use both delete and empty-string assignment because
    // Bun's process.env Proxy doesn't always propagate `delete` to the real
    // OS environ inherited by child processes.
    process.env.CLAUDECODE = '';
    delete process.env.CLAUDECODE;
    const { CLAUDECODE: _cc, CLAUDE_CODE_ENTRY_POINT: _ep, ...cleanEnv } = process.env;
    const sdkEnv = {
      ...cleanEnv,
      CLAUDECODE: undefined,
      CLAUDE_CODE_ENTRY_POINT: undefined,
      API_TIMEOUT_MS: process.env.API_TIMEOUT_MS ?? '14400000',
    };

    dlog.info('runProcess options check', {
      hasSystemPrefix: !!this.options.systemPrefix,
      systemPrefixLength: this.options.systemPrefix?.length ?? 0,
      systemPrefixPreview: this.options.systemPrefix?.slice(0, 120) ?? 'none',
      disallowedTools: this.options.disallowedTools?.join(', ') ?? 'none',
      permissionMode: this.options.permissionMode ?? 'none',
    });

    const sdkOptions: Record<string, any> = {
      pathToClaudeCodeExecutable: resolveSDKCliPath(),
      model: this.options.model,
      cwd: this.options.cwd,
      maxTurns: this.options.maxTurns,
      abortController: this.abortController,
      allowedTools: this.options.allowedTools,
      disallowedTools: this.options.disallowedTools,
      executable: 'node',
      env: sdkEnv,
      // Track per-file checkpoints so the UI can offer "Rewind code to here" /
      // "Fork conversation and rewind code". Required for query.rewindFiles().
      enableFileCheckpointing: true,
      systemPrompt: this.options.systemPrefix
        ? {
            type: 'preset' as const,
            preset: 'claude_code' as const,
            append: this.options.systemPrefix,
          }
        : { type: 'preset' as const, preset: 'claude_code' as const },
      tools: { type: 'preset', preset: 'claude_code' },
      settingSources: ['user', 'project'],
      hooks: {
        PreToolUse: [
          {
            matcher: '.*',
            hooks: [this.preToolUseHook.bind(this) as HookCallback],
            // Long timeout so the SDK doesn't auto-deny interactive tools
            // (AskUserQuestion, ExitPlanMode) while waiting for user input.
            // Without this, the SDK's default hook timeout (~3s) fires,
            // generates a deny tool_result, and the model retries — causing
            // duplicate questions in the UI.
            timeout: 14400, // 4 hours, matches API_TIMEOUT_MS
          },
        ],
      },
      stderr: (data: string) => {
        const trimmed = data.trimEnd();
        console.error('[sdk-claude-process:stderr]', trimmed);
        this.stderrBuffer.push(trimmed);
      },
    };

    if (this.options.sessionId) {
      sdkOptions.resume = this.options.sessionId;
      dlog.info('SDK query will resume session', { sessionId: this.options.sessionId });
    } else {
      dlog.info('SDK query starting fresh (no session to resume)');
    }

    if (this.options.permissionMode) {
      sdkOptions.permissionMode = this.options.permissionMode;
      if (this.options.permissionMode === 'bypassPermissions') {
        sdkOptions.allowDangerouslySkipPermissions = true;
      }
    }

    // Pass custom spawn function for sandboxed execution (e.g., Podman)
    // When sandboxed, bypass all permission checks — the container IS the sandbox
    if (this.options.spawnClaudeCodeProcess) {
      sdkOptions.spawnClaudeCodeProcess = this.options.spawnClaudeCodeProcess;
      sdkOptions.permissionMode = 'bypassPermissions';
      sdkOptions.allowDangerouslySkipPermissions = true;
    }

    // Custom spawn wrapper to:
    // 1. Strip CLAUDECODE from the child env at spawn-time (prevents "nested
    //    session" detection even if the SDK or Bun re-injects it into the env).
    // 2. On Windows, use 'pipe' stdio to avoid inheriting the server socket.
    if (!sdkOptions.spawnClaudeCodeProcess) {
      const { spawn } = await import('child_process');
      sdkOptions.spawnClaudeCodeProcess = (options: {
        command: string;
        args: string[];
        cwd?: string;
        env: Record<string, string | undefined>;
        signal: AbortSignal;
      }) => {
        // Final CLAUDECODE strip — belt-and-suspenders with the earlier env clean
        const { CLAUDECODE: _stripped, CLAUDE_CODE_ENTRY_POINT: _ep2, ...spawnEnv } = options.env;
        const child = spawn(options.command, options.args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          cwd: options.cwd,
          env: spawnEnv as NodeJS.ProcessEnv,
          windowsHide: true,
        });
        child.stderr?.on('data', (data: Buffer) => {
          dlog.error('child stderr', { data: data.toString().trimEnd() });
        });
        if (process.platform === 'win32') {
          // On Windows, child.kill('SIGTERM') only kills the immediate process,
          // not the subprocess tree. Use taskkill /F /T to kill the entire tree.
          const killTree = () => {
            if (child.pid != null) {
              try {
                Bun.spawnSync(['taskkill', '/F', '/T', '/PID', String(child.pid)]);
              } catch {
                // Best-effort: process may have already exited
              }
            }
          };
          if (options.signal.aborted) {
            killTree();
          } else {
            const onAbort = () => killTree();
            options.signal.addEventListener('abort', onAbort, { once: true });
            child.once('exit', () => options.signal.removeEventListener('abort', onAbort));
          }
        }
        return child;
      };
    }

    // Pass effort level to control thinking depth (Claude SDK specific).
    // Supported values: 'low' | 'medium' | 'high' | 'xhigh' | 'max'. The SDK
    // rejects unsupported levels per model at runtime; coerce unknown values
    // to 'high' defensively for un-validated callers.
    if (this.options.effort) {
      const validEfforts = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
      sdkOptions.effort = validEfforts.has(this.options.effort) ? this.options.effort : 'high';
    }

    // Pass MCP servers (e.g., CDP browser tools) if provided
    if (this.options.mcpServers) {
      sdkOptions.mcpServers = this.options.mcpServers;
      // Auto-allow all tools from MCP servers
      const mcpWildcards = Object.keys(this.options.mcpServers).map((name) => `mcp__${name}__*`);
      sdkOptions.allowedTools = [...(sdkOptions.allowedTools || []), ...mcpWildcards];
    }

    dlog.info('Starting SDK query', {
      executable: sdkOptions.executable,
      model: sdkOptions.model,
      cwd: sdkOptions.cwd,
      hasResume: !!sdkOptions.resume,
      permissionMode: sdkOptions.permissionMode,
      effort: sdkOptions.effort ?? 'default',
    });
    const gen = query({ prompt: promptInput, options: sdkOptions });
    this.activeQuery = gen;

    try {
      let msgCount = 0;
      for await (const sdkMsg of gen) {
        if (this.isAborted) {
          dlog.debug('Loop aborted, breaking', { msgCount });
          break;
        }

        msgCount++;
        dlog.debug(`SDK message #${msgCount}`, {
          type: sdkMsg.type,
          subtype: (sdkMsg as any).subtype,
        });

        // Synthetic assistant messages (model: "<synthetic>") carry provider
        // errors like "API Error: 529 {...}" as plain text. Render them as a
        // collapsible ProviderError tool card instead of an opaque text bubble.
        if (sdkMsg.type === 'assistant') {
          const rawMsg = (sdkMsg as any).message;
          if (rawMsg?.model === '<synthetic>') {
            const errorText = (rawMsg.content ?? [])
              .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
              .map((b: any) => b.text)
              .join('\n')
              .trim();
            if (errorText) {
              dlog.info('Synthetic provider error', { preview: errorText.slice(0, 200) });
              this.emitErrorToolCall(errorText);
              continue;
            }
          }
        }

        const cliMsg = this.translateMessage(sdkMsg);
        if (cliMsg) {
          dlog.debug('Translated to CLIMessage', {
            type: cliMsg.type,
            ...(cliMsg.type === 'result'
              ? { subtype: cliMsg.subtype, isError: cliMsg.is_error }
              : {}),
            ...(cliMsg.type === 'assistant'
              ? {
                  contentBlocks: cliMsg.message.content.length,
                  toolUseBlocks: cliMsg.message.content
                    .filter((b: any) => b.type === 'tool_use')
                    .map((b: any) => b.name),
                }
              : {}),
          });
          this.emit('message', cliMsg);
        }
      }
      dlog.info('SDK query loop finished', { msgCount, aborted: this.isAborted });
    } catch (err: any) {
      if (this.isAborted || err?.name === 'AbortError') {
        dlog.debug('Query cancelled (AbortError)', { aborted: this.isAborted });
      } else {
        // Use captured stderr for a more specific error message when the process
        // exits with a generic error like "Claude Code process exited with code 1"
        const stderrText = this.stderrBuffer.join('\n').trim();
        const parsed = stderrText ? this.parseStderrError(stderrText) : null;
        const errorMsg = parsed ?? String(err);
        dlog.error('Query error', { error: errorMsg.slice(0, 300) });
        this.emit('error', new Error(errorMsg));
      }
    } finally {
      this.activeQuery = null;
      this.finalize();
    }
  }

  // ── Prompt building ─────────────────────────────────────────────

  private buildPromptInput(): string | AsyncIterable<any> {
    // In-process MCP servers (createSdkMcpServer) require streaming input mode
    const needsStreaming = !!this.options.images?.length || !!this.options.mcpServers;
    if (!needsStreaming) {
      return this.options.prompt;
    }
    return this.createStreamingPrompt();
  }

  private async *createStreamingPrompt(): AsyncGenerator<any, void, unknown> {
    const content: any[] = [{ type: 'text', text: this.options.prompt }];
    if (this.options.images?.length) {
      content.push(...this.options.images);
    }
    yield {
      type: 'user',
      session_id: '',
      message: {
        role: 'user',
        content,
      },
      parent_tool_use_id: null,
    };
  }

  // ── PreToolUse hook ─────────────────────────────────────────────

  private async preToolUseHook(
    input: any,
    _toolUseID: string | undefined,
    { signal }: { signal: AbortSignal },
  ): Promise<any> {
    const toolName: string = input.tool_name ?? '';

    // For AskUserQuestion / ExitPlanMode: hold the hook until the process
    // is killed. The message handler already sets the thread to "waiting"
    // when it sees the tool_use block. When the user answers, AgentRunner
    // kills this process and starts a new one with session resume.
    if (toolName === 'AskUserQuestion' || toolName === 'ExitPlanMode') {
      dlog.info(`preToolUseHook PAUSING for ${toolName}`, {
        toolName,
        alreadyAborted: signal.aborted,
        inputKeys: Object.keys(input),
      });
      return new Promise<any>((resolve) => {
        const onAbort = () => {
          dlog.info(`preToolUseHook RESUMED (abort signal) for ${toolName}`, { toolName });
          resolve({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: 'Session will resume with user input',
            },
          });
        };
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener('abort', onAbort, { once: true });
        }
      });
    }

    // File-editing tools in confirmEdit mode: pause until user approves.
    // Same pattern as AskUserQuestion — hold the hook, the message handler
    // detects the permission denial, transitions the thread to "waiting",
    // and the client shows the PermissionApprovalCard. When the user
    // approves, AgentRunner kills this process and resumes with approval.
    // Skip if the tool is already in allowedTools (user chose "Always Allow").
    const CONFIRM_EDIT_TOOLS = new Set(['Edit', 'Write', 'Bash', 'NotebookEdit']);
    const isExplicitlyAllowed = this.options.allowedTools?.includes(toolName);

    // Serialize once for lookup + sensitive-path checks below
    const serializedToolInputForRule = ((): string | undefined => {
      const ti = input.tool_input;
      if (!ti || typeof ti !== 'object') return undefined;
      if (toolName === 'Bash' && typeof (ti as any).command === 'string') {
        return (ti as any).command as string;
      }
      try {
        return JSON.stringify(ti);
      } catch {
        return undefined;
      }
    })();

    // Sensitive-path detection — used by both the persisted-rule lookup
    // (for the bypass executor) and the regular sensitive-path guard below.
    const SENSITIVE_PATH_TOOLS = new Set(['Bash', 'Edit', 'Write', 'NotebookEdit', 'Read']);
    const SENSITIVE_PATH_PATTERNS = [
      /(?:^|[^A-Za-z0-9_])\.claude(?:[/\s'"`]|$)/,
      /\.config\/claude/,
    ];
    const collectPathTargets = (tool: string, ti: any): string[] => {
      if (!ti || typeof ti !== 'object') return [];
      if (tool === 'Bash' && typeof ti.command === 'string') return [ti.command];
      const out: string[] = [];
      if (typeof ti.file_path === 'string') out.push(ti.file_path);
      if (typeof ti.notebook_path === 'string') out.push(ti.notebook_path);
      return out;
    };
    const touchesSensitive =
      SENSITIVE_PATH_TOOLS.has(toolName) &&
      collectPathTargets(toolName, input.tool_input).some((t) =>
        SENSITIVE_PATH_PATTERNS.some((rx) => rx.test(t)),
      );

    // Consult persisted "always allow / always deny" rules first. The
    // runtime injects this lookup; in tests / standalone runs it may be
    // undefined. Errors inside the lookup are swallowed by the caller.
    if (this.options.permissionRuleLookup) {
      try {
        const match = await this.options.permissionRuleLookup({
          toolName,
          toolInput: serializedToolInputForRule,
        });
        if (match?.decision === 'allow') {
          // Sensitive paths trigger an SDK-internal block AFTER the hook
          // decision, even when we say `allow`. Honor the user's saved rule
          // by performing the operation ourselves and returning a synthetic
          // tool_result via the deny channel — the model treats the
          // permissionDecisionReason as the tool's output.
          if (touchesSensitive && this.options.bypassExecutor) {
            try {
              const bypass = await this.options.bypassExecutor({
                toolName,
                toolInput: input.tool_input,
                cwd: this.options.cwd,
              });
              if (bypass) {
                dlog.info(`preToolUseHook BYPASS via persisted rule for sensitive ${toolName}`, {
                  toolName,
                  outputLen: bypass.output.length,
                });
                return {
                  hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    permissionDecision: 'deny',
                    permissionDecisionReason: bypass.output,
                  },
                };
              }
            } catch (err) {
              dlog.warn('bypassExecutor threw — falling through to plain allow', {
                toolName,
                error: String(err).slice(0, 200),
              });
            }
          }
          dlog.info(`preToolUseHook ALLOW via persisted rule for ${toolName}`, { toolName });
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'allow',
            },
          };
        }
        if (match?.decision === 'deny') {
          dlog.info(`preToolUseHook DENY via persisted rule for ${toolName}`, { toolName });
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: 'Denied by saved permission rule',
            },
          };
        }
      } catch (err) {
        dlog.warn('permissionRuleLookup threw — falling through to interactive prompt', {
          toolName,
          error: String(err).slice(0, 200),
        });
      }
    }

    if (
      this.options.originalPermissionMode === 'confirmEdit' &&
      CONFIRM_EDIT_TOOLS.has(toolName) &&
      !isExplicitlyAllowed
    ) {
      dlog.info(`preToolUseHook PAUSING for ${toolName} (confirmEdit mode)`, {
        toolName,
        alreadyAborted: signal.aborted,
      });
      return new Promise<any>((resolve) => {
        const onAbort = () => {
          dlog.info(`preToolUseHook RESUMED (abort signal) for ${toolName} (confirmEdit)`, {
            toolName,
          });
          resolve({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: 'Waiting for user approval in confirmEdit mode',
            },
          });
        };
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener('abort', onAbort, { once: true });
        }
      });
    }

    // Sensitive-path guard: even in autoEdit, pause when a tool touches a
    // protected location (e.g. ~/.claude/, ~/.config/claude/). Without this,
    // the SDK silently denies the call with a generic "sensitive file"
    // message and the user never sees a permission prompt — the agent just
    // keeps retrying. Skip when the tool was explicitly allowed (user chose
    // "Always Allow") or the user has opted into bypassPermissions/plan.
    // Reuses `touchesSensitive` computed above for the rule lookup.
    const modeAllowsBypass =
      this.options.originalPermissionMode === 'bypassPermissions' ||
      this.options.originalPermissionMode === 'plan';
    if (touchesSensitive && !isExplicitlyAllowed && !modeAllowsBypass) {
      dlog.info(`preToolUseHook PAUSING for ${toolName} (sensitive path)`, {
        toolName,
        alreadyAborted: signal.aborted,
      });
      return new Promise<any>((resolve) => {
        const onAbort = () => {
          dlog.info(`preToolUseHook RESUMED (abort signal) for ${toolName} (sensitive path)`, {
            toolName,
          });
          resolve({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: 'Waiting for user approval — sensitive path',
            },
          });
        };
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener('abort', onAbort, { once: true });
        }
      });
    }

    dlog.debug(`preToolUseHook ALLOW ${toolName}`);

    // Auto-allow all other tools
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
      },
    };
  }

  // ── Message translation ─────────────────────────────────────────

  private translateMessage(sdkMsg: SDKMessage): CLIMessage | null {
    switch (sdkMsg.type) {
      case 'system':
        if ('subtype' in sdkMsg && sdkMsg.subtype === 'init') {
          return {
            type: 'system',
            subtype: 'init',
            session_id: (sdkMsg as any).session_id,
            tools: (sdkMsg as any).tools,
            model: (sdkMsg as any).model,
            cwd: (sdkMsg as any).cwd,
          };
        }
        if ('subtype' in sdkMsg && sdkMsg.subtype === 'compact_boundary') {
          const raw = sdkMsg as any;
          return {
            type: 'compact_boundary',
            trigger: raw.compact_metadata?.trigger ?? 'auto',
            preTokens: raw.compact_metadata?.pre_tokens ?? 0,
            sessionId: raw.session_id ?? '',
          };
        }
        return null;

      case 'assistant': {
        const rawMsg = (sdkMsg as any).message;
        return {
          type: 'assistant',
          message: rawMsg,
          parent_tool_use_id: (sdkMsg as any).parent_tool_use_id,
        };
      }

      case 'user': {
        const raw = sdkMsg as any;
        if (!raw.message?.content) return null;
        // Ensure tool_result content is always a string
        const content = raw.message.content.map((block: any) => {
          if (block.type === 'tool_result' && typeof block.content !== 'string') {
            // Content from Task/subagent tools comes as an array of content blocks
            if (Array.isArray(block.content)) {
              const text = block.content
                .filter((b: any) => b.type === 'text' && b.text)
                .map((b: any) => b.text)
                .join('\n\n');
              return { ...block, content: text };
            }
            return { ...block, content: JSON.stringify(block.content) };
          }
          return block;
        });
        return {
          type: 'user',
          message: { ...raw.message, content },
        };
      }

      case 'rate_limit_event': {
        const r = sdkMsg as any;
        return {
          type: 'rate_limit',
          info: r.rate_limit_info,
          sessionId: r.session_id,
        };
      }

      case 'result': {
        const r = sdkMsg as any;
        return {
          type: 'result',
          subtype: r.subtype,
          is_error: r.is_error,
          duration_ms: r.duration_ms,
          num_turns: r.num_turns,
          result: r.result,
          total_cost_usd: r.total_cost_usd,
          session_id: r.session_id,
          errors: r.errors,
        };
      }

      default:
        // stream_event, hook_*, etc. — skip
        return null;
    }
  }
}
