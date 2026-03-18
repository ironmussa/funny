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
    const sdkEnv = {
      ...process.env,
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
        console.error('[sdk-claude-process:stderr]', data.trimEnd());
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

    // On Windows, prevent the SDK's child process from inheriting the server's
    // listening socket handle. The SDK's default spawn uses 'inherit' stdio which
    // causes bInheritHandles=TRUE, inheriting ALL handles — including the server
    // socket. Using 'pipe' triggers PROC_THREAD_ATTRIBUTE_HANDLE_LIST in libuv,
    // restricting inheritance to only the pipe handles.
    // Same pattern as sandbox-manager.ts createSpawnFn() and pty-manager.ts.
    if (process.platform === 'win32' && !sdkOptions.spawnClaudeCodeProcess) {
      const { spawn, execSync } = await import('child_process');
      sdkOptions.spawnClaudeCodeProcess = (options: {
        command: string;
        args: string[];
        cwd?: string;
        env: Record<string, string | undefined>;
        signal: AbortSignal;
      }) => {
        const child = spawn(options.command, options.args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          cwd: options.cwd,
          env: options.env as NodeJS.ProcessEnv,
          windowsHide: true,
        });
        // Capture stderr so we can diagnose startup failures (exit code 1)
        child.stderr?.on('data', (data: Buffer) => {
          dlog.error('child stderr', { data: data.toString().trimEnd() });
        });
        // On Windows, child.kill('SIGTERM') only kills the immediate process,
        // not the subprocess tree. Use taskkill /F /T to kill the entire tree.
        const killTree = () => {
          if (child.pid != null) {
            try {
              execSync(`taskkill /F /T /PID ${child.pid} 2>nul`, { windowsHide: true });
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
        return child;
      };
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
        dlog.error('Query error', { error: String(err).slice(0, 300) });
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
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
