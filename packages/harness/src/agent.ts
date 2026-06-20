import type { HarnessAgentDefinition, HarnessAgentOptions } from './contracts.js';
import { HarnessError } from './errors.js';
import { sandbox } from './sandbox.js';

export type {
  HarnessAgentDefinition,
  HarnessAgentOptions,
  HarnessPermissionMode,
} from './contracts.js';

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
