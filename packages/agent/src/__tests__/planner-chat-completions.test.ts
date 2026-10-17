import { afterEach, expect, it, spyOn } from 'bun:test';

import { ModelFactory } from '@funny/core/agents';

import { OrchestratorAgent } from '../agents/developer/orchestrator-agent.js';
import { PipelineServiceConfigSchema } from '../config/schema.js';
import type { IssueDetail } from '../trackers/tracker.js';

const issue: IssueDetail = {
  number: 1,
  title: 'Test',
  state: 'open',
  body: '',
  url: '',
  labels: [],
  assignee: null,
  commentsCount: 0,
  createdAt: '',
  updatedAt: '',
  comments: [],
  fullContext: '',
};
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>;
afterEach(() => fetchSpy?.mockRestore());
it('plans through an external API and carries tool results into the next turn', async () => {
  const plan = {
    summary: 'Done',
    approach: 'Test',
    files_to_modify: [],
    files_to_create: [],
    estimated_complexity: 'small',
    risks: [],
  };
  const toolCall = {
    id: 'tool-1',
    type: 'function',
    function: { name: 'unknown', arguments: '{}' },
  };
  fetchSpy = spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(
      Response.json({ choices: [{ message: { content: null, tool_calls: [toolCall] } }] }),
    )
    .mockResolvedValueOnce(
      Response.json({ choices: [{ message: { content: JSON.stringify(plan) } }] }),
    );
  const agent = new OrchestratorAgent(
    PipelineServiceConfigSchema.parse({}),
    new ModelFactory({ openai: { baseURL: 'http://127.0.0.1:8317/v1/', apiKey: 'key' } }),
  );
  expect(await agent.planIssue(issue, process.cwd())).toMatchObject(plan);
  expect(fetchSpy.mock.calls[0][0]).toBe('http://127.0.0.1:8317/v1/chat/completions');
  expect(fetchSpy.mock.calls[0][1]?.headers).toMatchObject({ Authorization: 'Bearer key' });
  const body = JSON.parse(fetchSpy.mock.calls[1][1]?.body as string);
  expect(body.messages[2].tool_calls).toEqual([toolCall]);
  expect(body.messages[3]).toEqual({
    role: 'tool',
    tool_call_id: 'tool-1',
    content: 'Unknown tool: unknown',
  });
});
