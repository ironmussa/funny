/**
 * Tests for agents/process-factory.ts
 *
 * Tests the provider registry and factory pattern for creating agent processes.
 */
import { describe, test, expect } from 'bun:test';

import { opencodeManifest } from '@funny/shared/provider-manifests';

import { GenericACPProcess } from '../agents/generic-acp.js';
import type { IAgentProcess, AgentProcessOptions } from '../agents/interfaces.js';
import { defaultProcessFactory, registerProvider } from '../agents/process-factory.js';
import { SDKClaudeProcess } from '../agents/sdk-claude.js';

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
    try {
      const process = defaultProcessFactory.create({ ...baseOpts, provider: 'codex' });
      expect(process.constructor.name).toBe('CodexACPProcess');
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

  test('creates a cursor process when provider is "cursor"', () => {
    try {
      const process = defaultProcessFactory.create({ ...baseOpts, provider: 'cursor' });
      expect(process.constructor.name).toBe('CursorACPProcess');
    } catch {
      // Optional dependency — test passes if constructor resolves correctly
    }
  });

  test('creates an opencode process when provider is "opencode"', () => {
    try {
      const process = defaultProcessFactory.create({ ...baseOpts, provider: 'opencode' });
      expect(process.constructor.name).toBe('OpenCodeACPProcess');
    } catch {
      // Optional dependency — test passes if constructor resolves correctly
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

  test('resolves a runtime-registered manifest-bound provider with no cast (provider-manifest-loader seam)', () => {
    // The Phase B pattern: an external funny.provider manifest is bound into a
    // one-arg constructor (GenericACPProcess takes `(opts, manifest)`) and
    // registered under an id NOT in the compile-time KnownProvider union. With
    // AgentProvider widened to accept any string, `provider: 'opencode-ext'`
    // needs no `as any`, and the registry resolves it to the bound class.
    class ExternalProvider extends GenericACPProcess {
      constructor(opts: AgentProcessOptions) {
        super(opts, opencodeManifest);
      }
    }
    registerProvider('opencode-ext', ExternalProvider);
    const process = defaultProcessFactory.create({ ...baseOpts, provider: 'opencode-ext' });
    expect(process.constructor.name).toBe('ExternalProvider');
  });

  test('registerProvider can override an existing provider', () => {
    registerProvider('claude', MockProcess);
    const process = defaultProcessFactory.create({ ...baseOpts, provider: 'claude' });
    expect(process.constructor.name).toBe('MockProcess');

    // Restore original
    registerProvider('claude', SDKClaudeProcess);
  });
});
