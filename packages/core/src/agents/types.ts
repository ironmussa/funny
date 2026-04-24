/**
 * Shared CLI message types and process options.
 * Extracted from the former claude-process.ts so that consumers
 * (interfaces, agent-runner, message-handler, tests) can import
 * these types without pulling in a concrete process implementation.
 */

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
    id: string;
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
  subtype: 'success' | 'error_max_turns' | 'error_during_execution' | 'error_max_budget_usd';
  is_error: boolean;
  duration_ms: number;
  num_turns: number;
  result?: string;
  total_cost_usd: number;
  session_id: string;
  errors?: string[];
}

export interface CLICompactBoundaryMessage {
  type: 'compact_boundary';
  trigger: 'manual' | 'auto';
  preTokens: number;
  sessionId: string;
}

export type CLIMessage =
  | CLISystemMessage
  | CLIAssistantMessage
  | CLIUserMessage
  | CLIResultMessage
  | CLICompactBoundaryMessage;

// ── Process Options ────────────────────────────────────────────────

export interface ClaudeProcessOptions {
  prompt: string;
  cwd: string;
  model?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  sessionId?: string;
  permissionMode?: string;
  /** Original permission mode before provider-specific resolution (e.g., 'confirmEdit', 'ask') */
  originalPermissionMode?: string;
  images?: any[];
  /** Provider identifier — used by AgentProcessOptions, passed through here for convenience. */
  provider?: string;
  /** MCP servers to pass to the SDK query() call (e.g., CDP browser tools) */
  mcpServers?: Record<string, any>;
  /** Extra instructions appended to the system prompt (e.g., arc purpose prompts, project instructions) */
  systemPrefix?: string;
  /** Effort level for Claude SDK — controls thinking depth ('low' | 'medium' | 'high' | 'xhigh' | 'max') */
  effort?: string;
  /** Additional environment variables to pass to the agent subprocess (e.g., API keys). */
  env?: Record<string, string>;
  /** Built-in skill names to disable (Deep Agent only, e.g., ['planning', 'code-review']) */
  builtinSkillsDisabled?: string[];
  /** Additional skill directory paths (Deep Agent only) */
  customSkillPaths?: string[];
  /** Custom agent name (Deep Agent only, default: 'funny-coding-assistant') */
  agentName?: string;
  /** Custom spawn function for sandboxed execution (e.g., Podman container) */
  spawnClaudeCodeProcess?: (options: {
    command: string;
    args: string[];
    cwd?: string;
    env: Record<string, string | undefined>;
    signal: AbortSignal;
  }) => any;
}
