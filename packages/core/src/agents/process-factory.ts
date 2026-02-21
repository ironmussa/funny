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

import type { IAgentProcessFactory, IAgentProcess, AgentProcessOptions } from './interfaces.js';
import { SDKClaudeProcess } from './sdk-claude.js';
import { CodexProcess } from './codex.js';
import { GeminiACPProcess } from './gemini-acp.js';
import { LLMApiProcess } from './llm/llm-api-process.js';

type ProcessConstructor = new (opts: AgentProcessOptions) => IAgentProcess;

const providerRegistry = new Map<string, ProcessConstructor>([
  ['claude', SDKClaudeProcess],
  ['codex', CodexProcess],
  ['gemini', GeminiACPProcess],
  ['llm-api', LLMApiProcess],
]);

/** Register a new provider process class at runtime. */
export function registerProvider(name: string, ctor: ProcessConstructor): void {
  providerRegistry.set(name, ctor);
}

export const defaultProcessFactory: IAgentProcessFactory = {
  create(opts: AgentProcessOptions): IAgentProcess {
    const Ctor = providerRegistry.get(opts.provider ?? 'claude') ?? SDKClaudeProcess;
    return new Ctor(opts);
  },
};
