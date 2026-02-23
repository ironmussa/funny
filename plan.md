# Plan: Replace Vercel AI SDK with Direct api-acp Integration

## Problem
The Vercel AI SDK `generateText` loop isn't working correctly with our `api-acp` server:
- Only 1 step executes (tool calls happen but tool results never feed back)
- `onStepFinish` fires with `toolResults: 0` despite `toolCalls: 1`
- The model generates tool_calls embedded in text, api-acp parses them, but the AI SDK tool execution loop breaks

## Solution
Replace `AgentExecutor` (Vercel AI SDK `generateText`) with a direct HTTP client that calls `api-acp` `/v1/chat/completions` and handles the tool execution loop ourselves.

## Files to Modify

### 1. `packages/core/src/agents/llm/agent-executor.ts` — **REWRITE**
Replace the entire implementation:
- Remove `generateText`, `tool`, `LanguageModel`, `StepResult` imports from `'ai'`
- Remove `ModelFactory` dependency (no longer need Vercel AI SDK models)
- Implement a simple agentic loop:
  1. Build OpenAI-format messages (system + user)
  2. POST to api-acp `/v1/chat/completions` with tools definition
  3. Parse response — if `finish_reason: "tool_calls"`, execute tools locally
  4. Append assistant message + tool results to conversation
  5. Loop until `finish_reason: "stop"` or maxTurns reached
- Keep the same `AgentExecutor.execute()` public API (returns `AgentResult`)
- Keep `onStepFinish` callback — now fires with BOTH toolCalls AND toolResults populated
- Tools: reuse existing tool definitions (bash, read, edit, glob, grep) but convert from Vercel AI SDK `tool()` format to simple `{ name, description, parameters, execute }` objects

### 2. `packages/core/src/agents/llm/browser-tools.ts` — **MINOR UPDATE**
- Convert from Vercel AI SDK `tool()` format to plain objects with `{ name, description, parameters, execute }`
- Keep the same lazy Playwright initialization logic

### 3. `packages/core/src/agents/llm/model-factory.ts` — **SIMPLIFY or REMOVE**
- No longer needed for Vercel AI SDK LanguageModel creation
- Either remove entirely or convert to a simple config resolver that returns `{ baseURL, apiKey, modelId }` for the api-acp endpoint
- The `funny-api-acp` provider config (baseURL, apiKey) is still needed

### 4. `packages/agent/src/core/quality-pipeline.ts` — **MINOR UPDATE**
- Update `createStepCallback` to match new callback signature
- The callback now receives richer data (toolCalls WITH toolResults in the same step)

### 5. `packages/agent/src/core/agent-roles.ts` — **NO CHANGE**
- Agent roles (system prompts, maxTurns, model) stay the same

## Implementation Details

### New AgentExecutor Loop (pseudocode)
```typescript
async execute(options): Promise<AgentResult> {
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ];

  const toolDefs = buildToolDefinitions(options.tools); // OpenAI format
  let steps = 0;

  while (steps < maxTurns) {
    // Call api-acp
    const response = await fetch(`${baseURL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelId,
        messages,
        tools: toolDefs,
      }),
    });

    const data = await response.json();
    const choice = data.choices[0];
    const assistantMsg = choice.message;

    // Append assistant message to conversation
    messages.push(assistantMsg);

    // If no tool calls, we're done
    if (choice.finish_reason !== 'tool_calls' || !assistantMsg.tool_calls?.length) {
      await onStepFinish?.({ stepNumber: steps, text: assistantMsg.content, toolCalls: [], toolResults: [], finishReason: 'stop' });
      break;
    }

    // Execute tools locally
    const toolResults = [];
    for (const tc of assistantMsg.tool_calls) {
      const tool = toolMap[tc.function.name];
      const args = JSON.parse(tc.function.arguments);
      const result = await tool.execute(args);
      toolResults.push({ toolCallId: tc.id, name: tc.function.name, result });

      // Append tool result message
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: typeof result === 'string' ? result : JSON.stringify(result),
      });
    }

    // Fire onStepFinish with BOTH toolCalls AND toolResults
    await onStepFinish?.({
      stepNumber: steps,
      text: assistantMsg.content ?? '',
      toolCalls: assistantMsg.tool_calls,
      toolResults,
      finishReason: 'tool-calls',
    });

    steps++;
  }

  return buildResult(messages, steps);
}
```

### Tool Format Conversion
Current Vercel AI SDK `tool()` format → New plain object format.

We'll use `zodToJsonSchema` (already a dependency via `zod-to-json-schema`) to convert Zod schemas to JSON Schema for the OpenAI tools format.

### api-acp Base URL Resolution
Read from config: `config.providers['funny-api-acp'].baseURL` (default: `http://localhost:4002`)
The api-acp server runs on the same machine.

## What We DON'T Change
- `api-acp` server — stays the same, we just call it directly via HTTP
- Agent roles / system prompts — unchanged
- Quality pipeline orchestration — unchanged (just callback signature update)
- Pipeline runner — unchanged
- Context loader — unchanged
- Tool implementations (bash exec, file read/write/edit, glob, grep) — same logic, different wrapper

## Risks & Mitigations
- **Tool execution errors**: Wrap each tool.execute() in try/catch, send error as tool result
- **Infinite loops**: maxTurns limit (already configured per role: 80 for tests, 30 for types)
- **Large responses**: api-acp already handles response sizing
- **Network errors**: Add retry logic for transient failures
