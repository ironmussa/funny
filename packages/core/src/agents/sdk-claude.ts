/**
 * SDKClaudeProcess — adapter that wraps @anthropic-ai/claude-agent-sdk query()
 * behind the IAgentProcess EventEmitter interface.
 *
 * Drop-in replacement for the former ClaudeProcess (CLI subprocess).
 * AgentRunner and AgentMessageHandler work unchanged.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage, HookCallback, Query } from '@anthropic-ai/claude-agent-sdk';

import { BaseAgentProcess } from './base-process.js';
import type { CLIMessage } from './types.js';

export class SDKClaudeProcess extends BaseAgentProcess {
  private activeQuery: Query | null = null;

  // ── Overrides ──────────────────────────────────────────────────

  async kill(): Promise<void> {
    await super.kill();
    // close() forcefully ends the query, stopping all in-flight API calls
    // and preventing further messages from being yielded
    this.activeQuery?.close();
  }

  // ── Provider-specific run loop ─────────────────────────────────

  protected async runProcess(): Promise<void> {
    const promptInput = this.buildPromptInput();

    const sdkOptions: Record<string, any> = {
      model: this.options.model,
      cwd: this.options.cwd,
      maxTurns: this.options.maxTurns,
      abortController: this.abortController,
      allowedTools: this.options.allowedTools,
      disallowedTools: this.options.disallowedTools,
      executable: 'node',
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      tools: { type: 'preset', preset: 'claude_code' },
      settingSources: ['user', 'project'],
      hooks: {
        PreToolUse: [
          {
            matcher: '.*',
            hooks: [this.preToolUseHook.bind(this) as HookCallback],
          },
        ],
      },
      stderr: (data: string) => {
        console.error('[sdk-claude-process:stderr]', data.trimEnd());
      },
    };

    if (this.options.sessionId) {
      sdkOptions.resume = this.options.sessionId;
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

    console.log(
      '[sdk-claude-process] Starting query with executable:',
      sdkOptions.executable,
      'model:',
      sdkOptions.model,
      'cwd:',
      sdkOptions.cwd,
    );
    const gen = query({ prompt: promptInput, options: sdkOptions });
    this.activeQuery = gen;

    try {
      for await (const sdkMsg of gen) {
        if (this.isAborted) break;

        const cliMsg = this.translateMessage(sdkMsg);
        if (cliMsg) {
          this.emit('message', cliMsg);
        }
      }
    } catch (err: any) {
      if (this.isAborted || err?.name === 'AbortError') {
        // Normal cancellation — not an error
      } else {
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
      return new Promise<any>((resolve) => {
        const onAbort = () => {
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

      case 'assistant':
        return {
          type: 'assistant',
          message: (sdkMsg as any).message,
          parent_tool_use_id: (sdkMsg as any).parent_tool_use_id,
        };

      case 'user': {
        const raw = sdkMsg as any;
        if (!raw.message?.content) return null;
        // Ensure tool_result content is always a string
        const content = raw.message.content.map((block: any) => {
          if (block.type === 'tool_result' && typeof block.content !== 'string') {
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
