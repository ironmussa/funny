/**
 * Default multi-provider process factory.
 *
 * Uses a registry map to route to the correct process class based on `opts.provider`.
 * Reusable by both the server (AgentRunner) and the pipeline service.
 *
 * To add a new provider:
 *   1. Create a class implementing IAgentProcess
 *   2. Call `registerProvider('name', MyProcess)` before creating agents
 */

import { CodexACPProcess } from './codex-acp.js';
import { CursorACPProcess } from './cursor-acp.js';
import { DeepAgentProcess } from './deepagent-process.js';
import { GeminiACPProcess } from './gemini-acp.js';
import type { IAgentProcessFactory, IAgentProcess, AgentProcessOptions } from './interfaces.js';
import { LLMApiProcess } from './llm/llm-api-process.js';
import { OpenCodeACPProcess } from './opencode-acp.js';
import { PiACPProcess } from './pi-acp.js';
import { SDKClaudeProcess } from './sdk-claude.js';

export type ProcessConstructor = new (opts: AgentProcessOptions) => IAgentProcess;

const providerRegistry = new Map<string, ProcessConstructor>([
  ['claude', SDKClaudeProcess],
  ['codex', CodexACPProcess],
  ['gemini', GeminiACPProcess],
  ['pi', PiACPProcess],
  ['cursor', CursorACPProcess],
  ['opencode', OpenCodeACPProcess],
  ['deepagent', DeepAgentProcess],
  ['llm-api', LLMApiProcess],
]);

/** Register a new provider process class at runtime. */
export function registerProvider(name: string, ctor: ProcessConstructor): void {
  providerRegistry.set(name, ctor);
}

/** Remove a runtime-registered provider. Returns true if it was registered. */
export function unregisterProvider(name: string): boolean {
  return providerRegistry.delete(name);
}

export const defaultProcessFactory: IAgentProcessFactory = {
  create(opts: AgentProcessOptions): IAgentProcess {
    const Ctor = providerRegistry.get(opts.provider ?? 'claude') ?? SDKClaudeProcess;
    return new Ctor(opts);
  },
};
