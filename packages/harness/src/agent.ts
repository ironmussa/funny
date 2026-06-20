import { HarnessError } from './errors.js';
import type { SandboxIntent } from './sandbox.js';
import { sandbox } from './sandbox.js';
import type { HarnessTool } from './tools.js';

export type HarnessPermissionMode = 'plan' | 'autoEdit' | 'confirmEdit' | (string & {});

export interface HarnessAgentOptions {
  name?: string;
  provider?: string;
  model?: string;
  instructions: string;
  permissionMode?: HarnessPermissionMode;
  allowedTools?: readonly string[];
  disallowedTools?: readonly string[];
  tools?: readonly HarnessTool[];
  mcpServers?: Record<string, unknown>;
  maxTurns?: number;
  effort?: string;
  sandbox?: SandboxIntent;
  metadata?: Record<string, unknown>;
}

export interface HarnessAgentDefinition {
  readonly name: string;
  readonly provider: string;
  readonly model?: string;
  readonly instructions: string;
  readonly permissionMode?: HarnessPermissionMode;
  readonly allowedTools: readonly string[];
  readonly disallowedTools: readonly string[];
  readonly tools: readonly HarnessTool[];
  readonly mcpServers?: Readonly<Record<string, unknown>>;
  readonly maxTurns?: number;
  readonly effort?: string;
  readonly sandbox: SandboxIntent;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export function createAgent(options: HarnessAgentOptions): HarnessAgentDefinition {
  if (!options || typeof options !== 'object') {
    throw new HarnessError('invalid_agent_definition', 'Agent options are required');
  }
  if (!options.instructions?.trim()) {
    throw new HarnessError('invalid_agent_definition', 'Agent instructions are required');
  }
  const provider = options.provider?.trim() || 'claude';
  const name = options.name?.trim() || provider;

  return Object.freeze({
    name,
    provider,
    model: options.model,
    instructions: options.instructions,
    permissionMode: options.permissionMode,
    allowedTools: Object.freeze([...(options.allowedTools ?? [])]),
    disallowedTools: Object.freeze([...(options.disallowedTools ?? [])]),
    tools: Object.freeze([...(options.tools ?? [])]),
    mcpServers: options.mcpServers ? Object.freeze({ ...options.mcpServers }) : undefined,
    maxTurns: options.maxTurns,
    effort: options.effort,
    sandbox: options.sandbox ?? sandbox.local(),
    metadata: options.metadata ? Object.freeze({ ...options.metadata }) : undefined,
  });
}
