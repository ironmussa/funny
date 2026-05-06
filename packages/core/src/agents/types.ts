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

export interface CLIRateLimitInfo {
  status: 'allowed' | 'allowed_warning' | 'rejected';
  resetsAt?: number;
  rateLimitType?: 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet' | 'overage';
  utilization?: number;
  overageStatus?: 'allowed' | 'allowed_warning' | 'rejected';
  overageResetsAt?: number;
  isUsingOverage?: boolean;
  surpassedThreshold?: number;
}

export interface CLIRateLimitMessage {
  type: 'rate_limit';
  info: CLIRateLimitInfo;
  sessionId: string;
}

export type CLIMessage =
  | CLISystemMessage
  | CLIAssistantMessage
  | CLIUserMessage
  | CLIResultMessage
  | CLICompactBoundaryMessage
  | CLIRateLimitMessage;

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
  /** Extra instructions appended to the system prompt (e.g., project instructions). */
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
  /**
   * Optional lookup callback for "always allow / always deny" permission
   * rules persisted on the central server. The hook calls it before
   * pausing on confirmEdit / sensitive-path tools — when it resolves with
   * a matching rule, the hook short-circuits with that decision instead
   * of waiting for user approval.
   *
   * Returns `null` when no rule matches. The runtime is expected to
   * swallow lookup errors and resolve to `null`.
   *
   * Lives in `core` as a callback (not a direct import) so this package
   * stays free of server / runtime dependencies.
   */
  permissionRuleLookup?: (query: {
    toolName: string;
    toolInput?: string;
  }) => Promise<{ decision: 'allow' | 'deny' } | null>;

  /**
   * Optional bypass executor invoked by the hook when a tool that touches a
   * sensitive path (e.g. `~/.claude/`) has a matching "allow" rule. The SDK
   * applies its own hardcoded sensitive-path block AFTER the hook returns —
   * so even when we tell it `permissionDecision: 'allow'`, the operation is
   * silently denied. To honor the user's saved rule we execute the operation
   * ourselves here, then surface the result via a synthetic tool_result so
   * the model sees it as success.
   *
   * Should return the text to use as the tool_result on success. Throwing or
   * resolving `null` causes the hook to fall back to the normal allow path
   * (which will end up denied by the SDK's sensitive-path guard, surfacing a
   * fresh permission request to the user).
   */
  bypassExecutor?: (query: {
    toolName: string;
    toolInput: unknown;
    cwd?: string;
  }) => Promise<{ output: string } | null>;
}
