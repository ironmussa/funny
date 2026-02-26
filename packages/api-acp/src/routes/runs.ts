/**
 * /v1/runs — Agent run lifecycle endpoints.
 *
 * POST   /              → Create a run (start agent query)
 * GET    /:id           → Get run status
 * POST   /:id/cancel    → Cancel an in-flight run
 *
 * Replaces the former OpenAI-compatible /v1/chat/completions endpoint
 * with an agent-oriented protocol that exposes lifecycle states,
 * tool calls, and proper cancellation.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import { Hono } from 'hono';

import { resolveModel } from '../utils/model-resolver.js';
import * as registry from '../utils/run-registry.js';
import type { RunResult, RunUsage, ToolCallInfo } from '../utils/run-registry.js';

const DEBUG = !!process.env.API_ACP_DEBUG;
function dbg(msg: string) {
  if (DEBUG) console.log(msg);
}

export const runsRoute = new Hono();

// ── Types ────────────────────────────────────────────────

interface OpenAIToolDef {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

interface CreateRunRequest {
  model: string;
  system_prompt?: string;
  prompt: string;
  tools?: OpenAIToolDef[];
  max_turns?: number;
  stream?: boolean;
}

// ── JSON Repair (reused from former chat.ts) ─────────────

function repairJsonArgs(args: string): string {
  try {
    JSON.parse(args);
    return args;
  } catch {}

  let s = args.trim();
  for (let i = 0; i < 3; i++) {
    if (s.endsWith('}}')) {
      const attempt = s.slice(0, -1);
      try {
        JSON.parse(attempt);
        return attempt;
      } catch {}
    }
    if (s.endsWith(']]')) {
      const attempt = s.slice(0, -1);
      try {
        JSON.parse(attempt);
        return attempt;
      } catch {}
    }
    s = s.slice(0, -1);
    if (!s) break;
  }

  s = args.trim();
  for (let i = 0; i < 3; i++) {
    s += '}';
    try {
      JSON.parse(s);
      return s;
    } catch {}
  }

  s = args.trim();
  for (let i = 0; i < 3; i++) {
    s += ']';
    try {
      JSON.parse(s);
      return s;
    } catch {}
  }

  if (!args.trim().startsWith('{')) {
    const attempt = `{${args.trim()}}`;
    try {
      JSON.parse(attempt);
      return attempt;
    } catch {}
  }

  console.warn(`[api-acp] WARNING: could not repair JSON args: ${args.slice(0, 200)}`);
  return args;
}

function tryParseJsonArray(raw: string): any[] | null {
  const s = raw.trim();
  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed)) return parsed;
    return null;
  } catch {}

  let inString = false;
  let escape = false;
  let braces = 0;
  let brackets = 0;
  for (const ch of s) {
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') braces++;
    if (ch === '}') braces--;
    if (ch === '[') brackets++;
    if (ch === ']') brackets--;
  }

  let fixed = s;
  for (let i = 0; i < braces; i++) fixed += '}';
  for (let i = 0; i < brackets; i++) fixed += ']';
  try {
    const parsed = JSON.parse(fixed);
    if (Array.isArray(parsed)) return parsed;
  } catch {}

  return null;
}

// ── Tool Call Parsing ────────────────────────────────────

function parseToolCalls(text: string): { toolCalls: ToolCallInfo[]; textContent: string } | null {
  const patterns: RegExp[] = [
    /```tool_calls\s*\n([\s\S]*?)\n\s*```/,
    /<function_calls>\s*\n?([\s\S]*?)\n?\s*<\/function_calls>/,
  ];

  let bestMatch: RegExpMatchArray | null = null;
  let bestIndex = Infinity;

  for (const regex of patterns) {
    const match = text.match(regex);
    if (match && match.index !== undefined && match.index < bestIndex) {
      bestMatch = match;
      bestIndex = match.index;
    }
  }

  if (!bestMatch) return null;

  const parsed = tryParseJsonArray(bestMatch[1]);
  if (!parsed) return null;

  try {
    const toolCalls: ToolCallInfo[] = parsed.map((tc: any, i: number) => {
      const rawArgs = tc.function?.arguments ?? tc.arguments;
      let argsStr: string;
      if (typeof rawArgs === 'string') {
        argsStr = repairJsonArgs(rawArgs);
      } else {
        argsStr = JSON.stringify(rawArgs ?? {});
      }

      const uid = `call_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}_${i}`;

      return {
        id: uid,
        type: 'function' as const,
        function: {
          name: tc.function?.name ?? tc.name ?? 'unknown',
          arguments: argsStr,
        },
      };
    });

    const textContent = text.slice(0, bestMatch.index).trim();
    return { toolCalls, textContent };
  } catch {
    return null;
  }
}

// ── Helpers ──────────────────────────────────────────────

function buildToolInstruction(tools: OpenAIToolDef[]): string {
  if (!tools.length) return '';

  const toolDescriptions = tools
    .map((t) => {
      const params = t.function.parameters
        ? `\n  Parameters: ${JSON.stringify(t.function.parameters)}`
        : '';
      return `- ${t.function.name}: ${t.function.description ?? 'No description'}${params}`;
    })
    .join('\n');

  return `
You have access to the following tools. To call a tool, output a JSON array inside a fenced code block:

\`\`\`tool_calls
[{"id":"call_001","type":"function","function":{"name":"TOOL_NAME","arguments":{"param":"value"}}}]
\`\`\`

IMPORTANT: The "arguments" field must be a JSON OBJECT (not a string). Example:
✅ "arguments":{"path":"/src/index.ts","content":"hello"}
❌ "arguments":"{\\"path\\":\\"/src/index.ts\\"}"

Available tools:
${toolDescriptions}

CRITICAL RULES:
1. Output ONLY ONE tool_calls block per response, then STOP IMMEDIATELY.
2. Do NOT simulate, imagine, or fabricate tool results. You will receive REAL results in the next message.
3. Do NOT output any text after the tool_calls block. Your response ENDS at the closing block.
4. You may include a brief explanation BEFORE the tool_calls block.
5. If you don't need any tools, respond normally with text (no tool_calls block).
6. Each tool call MUST have a unique "id" like "call_001", "call_002", etc.`;
}

/** SSE helper: encode an event line. */
function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// ── POST / — Create Run ─────────────────────────────────

runsRoute.post('/', async (c) => {
  const body = await c.req.json<CreateRunRequest>();
  const { model: requestedModel, system_prompt, prompt, tools, max_turns, stream } = body;

  console.log(
    `[api-acp] POST /v1/runs model=${requestedModel} stream=${stream} tools=${tools?.length ?? 0}`,
  );

  if (!requestedModel) {
    return c.json({ error: { message: 'model is required', type: 'invalid_request_error' } }, 400);
  }
  if (!prompt) {
    return c.json({ error: { message: 'prompt is required', type: 'invalid_request_error' } }, 400);
  }

  const { modelId } = resolveModel(requestedModel);
  const hasTools = !!tools?.length;
  const toolInstruction = hasTools ? buildToolInstruction(tools) : '';
  const fullSystemPrompt = [system_prompt, toolInstruction].filter(Boolean).join('\n\n');

  const runId = registry.makeRunId();
  const abortController = new AbortController();
  const run = registry.register(runId, requestedModel, abortController);

  if (stream) {
    return handleStreaming(
      run,
      modelId,
      prompt,
      fullSystemPrompt,
      hasTools,
      max_turns,
      abortController,
    );
  }
  return handleNonStreaming(
    c,
    run,
    modelId,
    prompt,
    fullSystemPrompt,
    hasTools,
    max_turns,
    abortController,
  );
});

// ── GET /:id — Get Run Status ───────────────────────────

runsRoute.get('/:id', (c) => {
  const id = c.req.param('id');
  const run = registry.get(id);
  if (!run) {
    return c.json({ error: { message: 'Run not found', type: 'not_found' } }, 404);
  }
  return c.json(run);
});

// ── POST /:id/cancel — Cancel Run ──────────────────────

runsRoute.post('/:id/cancel', (c) => {
  const id = c.req.param('id');
  const cancelled = registry.cancel(id);
  if (!cancelled) {
    const run = registry.get(id);
    if (!run) {
      return c.json({ error: { message: 'Run not found', type: 'not_found' } }, 404);
    }
    return c.json(
      { error: { message: `Run is already ${run.status}`, type: 'invalid_request_error' } },
      400,
    );
  }
  return c.json(registry.get(id));
});

// ── Non-streaming handler ────────────────────────────────

async function handleNonStreaming(
  c: any,
  run: ReturnType<typeof registry.register>,
  modelId: string,
  prompt: string,
  systemPrompt: string,
  hasTools: boolean,
  maxTurns: number | undefined,
  abortController: AbortController,
) {
  registry.setRunning(run.id);

  try {
    const textParts: string[] = [];
    let inputTokens = 0;
    let outputTokens = 0;

    const gen = query({
      prompt,
      options: {
        model: modelId,
        maxTurns: maxTurns ?? (hasTools ? 1 : 50),
        executable: 'node',
        systemPrompt: systemPrompt || undefined,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        abortController,
        ...(hasTools ? { tools: [] } : {}),
      },
    });

    registry.setQuery(run.id, gen);

    for await (const msg of gen) {
      dbg(
        `[api-acp] SDK msg type=${msg.type}${(msg as any).subtype ? ` subtype=${(msg as any).subtype}` : ''}`,
      );
      if (msg.type === 'assistant') {
        const raw = msg as any;
        if (raw.message?.content) {
          for (const block of raw.message.content) {
            if (block.type === 'text') {
              textParts.push(block.text);
            }
          }
          if (raw.message.usage) {
            inputTokens += raw.message.usage.input_tokens ?? 0;
            outputTokens += raw.message.usage.output_tokens ?? 0;
          }
        }
      }
      if (msg.type === 'result') {
        const raw = msg as any;
        if (textParts.length === 0 && raw.result) {
          textParts.push(raw.result);
        }
      }
    }

    const fullText = textParts.join('');
    const usage: RunUsage = { input_tokens: inputTokens, output_tokens: outputTokens };

    // Check for tool calls in output
    let result: RunResult;
    if (hasTools) {
      const parsed = parseToolCalls(fullText);
      if (parsed) {
        result = { text: parsed.textContent, tool_calls: parsed.toolCalls };
      } else {
        result = { text: fullText };
      }
    } else {
      result = { text: fullText };
    }

    registry.setCompleted(run.id, result, usage);
    return c.json(registry.get(run.id));
  } catch (err: any) {
    console.error('[api-acp] run error:', err.message);
    registry.setFailed(run.id, err.message);
    return c.json(registry.get(run.id), 500);
  }
}

// ── Streaming handler ────────────────────────────────────

function handleStreaming(
  run: ReturnType<typeof registry.register>,
  modelId: string,
  prompt: string,
  systemPrompt: string,
  hasTools: boolean,
  maxTurns: number | undefined,
  abortController: AbortController,
) {
  const encoder = new TextEncoder();

  const readableStream = new ReadableStream({
    async start(controller) {
      registry.setRunning(run.id);

      try {
        // Emit run.created
        controller.enqueue(encoder.encode(sseEvent('run.created', registry.get(run.id))));

        // Emit run.status → running
        controller.enqueue(
          encoder.encode(sseEvent('run.status', { id: run.id, status: 'running' })),
        );

        let inputTokens = 0;
        let outputTokens = 0;
        let accumulatedText = '';

        const gen = query({
          prompt,
          options: {
            model: modelId,
            maxTurns: maxTurns ?? (hasTools ? 1 : 50),
            executable: 'node',
            systemPrompt: systemPrompt || undefined,
            permissionMode: 'bypassPermissions',
            allowDangerouslySkipPermissions: true,
            abortController,
            ...(hasTools ? { tools: [] } : {}),
          },
        });

        registry.setQuery(run.id, gen);

        for await (const msg of gen) {
          dbg(`[api-acp] SDK stream msg type=${msg.type}`);

          if (msg.type === 'assistant') {
            const raw = msg as any;
            if (raw.message?.content) {
              for (const block of raw.message.content) {
                if (block.type === 'text') {
                  accumulatedText += block.text;

                  // In tool mode, buffer text to parse tool_calls at the end.
                  // In normal mode, stream text deltas immediately.
                  if (!hasTools) {
                    controller.enqueue(
                      encoder.encode(sseEvent('text.delta', { delta: block.text })),
                    );
                  }
                }
              }
              if (raw.message.usage) {
                inputTokens += raw.message.usage.input_tokens ?? 0;
                outputTokens += raw.message.usage.output_tokens ?? 0;
              }
            }
          }

          if (msg.type === 'result') {
            const raw = msg as any;
            if (raw.result && !accumulatedText) {
              accumulatedText = raw.result;
              if (!hasTools) {
                controller.enqueue(encoder.encode(sseEvent('text.delta', { delta: raw.result })));
              }
            }
          }
        }

        const usage: RunUsage = { input_tokens: inputTokens, output_tokens: outputTokens };

        // Build result
        let result: RunResult;
        if (hasTools && accumulatedText) {
          const parsed = parseToolCalls(accumulatedText);
          if (parsed) {
            // Emit text content if any
            if (parsed.textContent) {
              controller.enqueue(
                encoder.encode(sseEvent('text.delta', { delta: parsed.textContent })),
              );
            }
            // Emit each tool call
            for (const tc of parsed.toolCalls) {
              controller.enqueue(encoder.encode(sseEvent('tool_call.created', tc)));
            }
            result = { text: parsed.textContent, tool_calls: parsed.toolCalls };
          } else {
            // No tool calls found — just send text
            controller.enqueue(encoder.encode(sseEvent('text.delta', { delta: accumulatedText })));
            result = { text: accumulatedText };
          }
        } else {
          result = { text: accumulatedText };
        }

        registry.setCompleted(run.id, result, usage);

        // Emit run.completed with full run object
        controller.enqueue(encoder.encode(sseEvent('run.completed', registry.get(run.id))));
        controller.enqueue(encoder.encode(sseEvent('done', '[DONE]')));
        controller.close();
      } catch (err: any) {
        console.error('[api-acp] stream error:', err.message);
        registry.setFailed(run.id, err.message);
        controller.enqueue(
          encoder.encode(sseEvent('run.failed', { id: run.id, error: { message: err.message } })),
        );
        controller.enqueue(encoder.encode(sseEvent('done', '[DONE]')));
        controller.close();
      }
    },
    cancel() {
      console.log(`[api-acp] client disconnected, cancelling run ${run.id}`);
      registry.cancel(run.id);
    },
  });

  return new Response(readableStream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
