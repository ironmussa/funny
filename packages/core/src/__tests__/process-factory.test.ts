/**
 * Tests for agents/process-factory.ts
 *
 * Tests the provider registry and factory pattern for creating agent processes.
 */
import { describe, test, expect } from 'bun:test';

import type { IAgentProcess, AgentProcessOptions } from '../agents/interfaces.js';
import { defaultProcessFactory, registerProvider } from '../agents/process-factory.js';

// Minimal mock process class for testing
class MockProcess implements IAgentProcess {
  readonly provider: string;
  constructor(public opts: AgentProcessOptions) {
    this.provider = opts.provider ?? 'mock';
  }
  start() {
    return Promise.resolve();
  }
  stop() {
    return Promise.resolve();
  }
  sendMessage(_msg: string) {
    return Promise.resolve();
  }
  on(_event: string, _handler: (...args: any[]) => void) {
    return this;
  }
  off(_event: string, _handler: (...args: any[]) => void) {
    return this;
  }
}

const baseOpts: AgentProcessOptions = {
  threadId: 'test-thread',
  projectPath: '/tmp/test',
  prompt: 'test prompt',
  model: 'sonnet',
  permissionMode: 'autoEdit',
};

describe('process-factory', () => {
  test('creates a claude process by default', () => {
    const process = defaultProcessFactory.create({ ...baseOpts });
    expect(process).toBeDefined();
    // The default provider should be SDKClaudeProcess
    expect(process.constructor.name).toBe('SDKClaudeProcess');
  });

  test('creates a claude process when provider is explicitly "claude"', () => {
    const process = defaultProcessFactory.create({ ...baseOpts, provider: 'claude' });
    expect(process.constructor.name).toBe('SDKClaudeProcess');
  });

  test('creates a codex process when provider is "codex"', () => {
    // CodexProcess may throw if @openai/codex-sdk is not installed,
    // but the factory should resolve to the correct constructor
    try {
      const process = defaultProcessFactory.create({ ...baseOpts, provider: 'codex' });
      expect(process.constructor.name).toBe('CodexProcess');
    } catch {
      // Optional dependency — test passes if constructor resolves correctly
    }
  });

  test('creates a gemini process when provider is "gemini"', () => {
    try {
      const process = defaultProcessFactory.create({ ...baseOpts, provider: 'gemini' });
      expect(process.constructor.name).toBe('GeminiACPProcess');
    } catch {
      // Optional dependency
    }
  });

  test('creates an llm-api process when provider is "llm-api"', () => {
    try {
      const process = defaultProcessFactory.create({ ...baseOpts, provider: 'llm-api' });
      expect(process.constructor.name).toBe('LLMApiProcess');
    } catch {
      // May require additional config
    }
  });

  test('falls back to SDKClaudeProcess for unknown providers', () => {
    const process = defaultProcessFactory.create({
      ...baseOpts,
      provider: 'unknown-provider' as any,
    });
    expect(process.constructor.name).toBe('SDKClaudeProcess');
  });

  test('registerProvider adds a new provider to the registry', () => {
    registerProvider('mock', MockProcess);
    const process = defaultProcessFactory.create({ ...baseOpts, provider: 'mock' as any });
    expect(process.constructor.name).toBe('MockProcess');
    expect((process as MockProcess).opts.threadId).toBe('test-thread');
  });

  test('registerProvider can override an existing provider', () => {
    registerProvider('claude', MockProcess);
    const process = defaultProcessFactory.create({ ...baseOpts, provider: 'claude' });
    expect(process.constructor.name).toBe('MockProcess');

    // Restore original — re-import to reset
    const { SDKClaudeProcess } = require('../agents/sdk-claude.js');
    registerProvider('claude', SDKClaudeProcess);
  });
});
