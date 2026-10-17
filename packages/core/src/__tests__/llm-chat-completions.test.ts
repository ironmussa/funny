import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import type { AgentContext, AgentRole } from '../agents/llm/agent-context.js';
import { AgentExecutor } from '../agents/llm/agent-executor.js';
import { ModelFactory } from '../agents/llm/model-factory.js';

const role: AgentRole = {
  name: 'review',
  systemPrompt: 'Review changes',
  model: 'external-model',
  provider: 'openai',
  tools: [],
  maxTurns: 3,
};
const context: AgentContext = {
  branch: 'feature',
  baseBranch: 'main',
  worktreePath: process.cwd(),
  tier: 'small',
  previousResults: [],
  diffStats: { files_changed: 0, lines_added: 0, lines_deleted: 0, changed_files: [] },
};
let fetchSpy: MockInstance<typeof fetch> | undefined;
afterEach(() => fetchSpy?.mockRestore());

describe('external Chat Completions executor', () => {
  it('sends tool results with matching IDs and accumulates usage across turns', async () => {
    const toolCall = {
      id: 'call-1',
      type: 'function',
      function: { name: 'unknown_tool', arguments: '{}' },
    };
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        Response.json({
          choices: [{ message: { content: null, tool_calls: [toolCall] } }],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          choices: [
            { message: { content: '{"status":"passed","findings":[],"fixes_applied":0}' } },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 3 },
        }),
      );
    const result = await new AgentExecutor(
      'http://127.0.0.1:8317/v1/',
      'external-model',
      'client-key',
    ).execute(role, context);
    expect(result.status).toBe('passed');
    expect(result.metadata.tokens_used).toEqual({ input: 30, output: 5 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0][0]).toBe('http://127.0.0.1:8317/v1/chat/completions');
    expect(fetchSpy.mock.calls[0][1]?.headers).toMatchObject({
      Authorization: 'Bearer client-key',
    });
    const body = JSON.parse(fetchSpy.mock.calls[1][1]?.body as string);
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
    ]);
    expect(body.messages[2].tool_calls).toEqual([toolCall]);
    expect(body.messages[3]).toEqual({
      role: 'tool',
      tool_call_id: 'call-1',
      content: 'Error: Unknown tool "unknown_tool"',
    });
    expect(body).not.toHaveProperty('prompt');
    expect(body).not.toHaveProperty('max_turns');
  });

  it('rejects tool arguments that do not match the tool schema without running the tool', async () => {
    const toolCall = {
      id: 'call-bad-args',
      type: 'function',
      function: { name: 'read', arguments: '{"path":42}' },
    };
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        Response.json({ choices: [{ message: { content: null, tool_calls: [toolCall] } }] }),
      )
      .mockResolvedValueOnce(
        Response.json({
          choices: [
            { message: { content: '{"status":"passed","findings":[],"fixes_applied":0}' } },
          ],
        }),
      );
    await new AgentExecutor('http://127.0.0.1:8317/v1', 'model').execute(role, context);
    const body = JSON.parse(fetchSpy.mock.calls[1][1]?.body as string);
    const toolMessage = body.messages[3];
    expect(toolMessage.tool_call_id).toBe('call-bad-args');
    expect(toolMessage.content).toMatch(/^Error executing read: read arguments: path: /);
  });

  it('reports malformed completion responses as errors', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ choices: [] }));
    const result = await new AgentExecutor('http://127.0.0.1:8317/v1', 'model').execute(
      role,
      context,
    );
    expect(result.status).toBe('error');
    expect(result.findings[0].description).toContain('no completion');
  });

  it('does not call the provider when already cancelled', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = await new AgentExecutor('http://127.0.0.1:8317/v1', 'model').execute(
      role,
      context,
      { signal: AbortSignal.abort() },
    );
    expect(result.status).toBe('error');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('resolves an externally configured provider and rejects the removed provider', () => {
    const factory = new ModelFactory({
      openai: { baseURL: 'http://127.0.0.1:8317/v1', apiKey: 'key' },
    });
    expect(factory.resolve('openai', 'custom-model')).toEqual({
      baseURL: 'http://127.0.0.1:8317/v1',
      apiKey: 'key',
      modelId: 'custom-model',
    });
    expect(() => factory.resolve('funny-api-acp', 'sonnet')).toThrow('Unknown LLM provider');
  });
});
