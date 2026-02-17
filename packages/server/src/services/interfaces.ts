/**
 * Re-exports for backward compatibility during migration.
 * Agent interfaces now live in @funny/core.
 * Server-specific interfaces live in ./server-interfaces.ts.
 */
export type { IThreadManager, IWSBroker } from './server-interfaces.js';
export type {
  IAgentProcess,
  IClaudeProcess,
  AgentProcessOptions,
  IAgentProcessFactory,
  IClaudeProcessFactory,
} from '@funny/core/agents';
