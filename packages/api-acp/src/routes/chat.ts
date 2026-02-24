/**
 * POST /v1/chat/completions — OpenAI-compatible chat completions endpoint.
 *
 * Uses the Claude Agent SDK `query()` directly.
 * No API keys needed — uses the CLI's own authentication.
 * Supports both streaming (SSE) and non-streaming responses.
 *
 * When `tools` are provided in the request, the model will output tool_calls
 * instead of executing them, enabling OpenAI-style function calling.
 */

import { Hono } from 'hono';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { resolveModel } from '../utils/model-resolver.js';
import {
  makeCompletionId,
  toOpenAIChatCompletion,
  toOpenAIStreamChunk,
  sseEncode,
} from '../utils/format.js';
import * as activeQueries from '../utils/active-queries.js';
const DEBUG = !!process.env.API_ACP_DEBUG;
function dbg(msg: string) {
  if (DEBUG) console.log(msg);
}

export const chatRoute = new Hono();

// ── Types ────────────────────────────────────────────────

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OpenAIToolDef {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

interface ChatCompletionRequest {
  model: string;
  messages: OpenAIMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  top_p?: number;
  stop?: string | string[];
  tools?: OpenAIToolDef[];
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
}

// ── JSON Repair ─────────────────────────────────────────

/**
 * Ensure a tool_call's `arguments` string is valid JSON.
 * LangChain does JSON.parse(arguments) on each tool_call — if it fails,
 * the call goes to `invalid_tool_calls` and is never executed (causing loops).
 */
function repairJsonArgs(args: string): string {
  // Fast path: already valid
  try { JSON.parse(args); return args; } catch {}

  let s = args.trim();

  // Fix 1: Extra trailing braces/brackets  e.g. {"path":"."}}  →  {"path":"."}
  for (let i = 0; i < 3; i++) {
    if (s.endsWith('}}')) {
      const attempt = s.slice(0, -1);
      try { JSON.parse(attempt); return attempt; } catch {}
    }
    if (s.endsWith(']]')) {
      const attempt = s.slice(0, -1);
      try { JSON.parse(attempt); return attempt; } catch {}
    }
    s = s.slice(0, -1); // peel one char and retry full set
    if (!s) break;
  }

  // Fix 2: Missing closing braces  e.g. {"path":"."  →  {"path":"."}
  s = args.trim();
  for (let i = 0; i < 3; i++) {
    s += '}';
    try { JSON.parse(s); return s; } catch {}
  }

  // Fix 3: Missing closing bracket for arrays
  s = args.trim();
  for (let i = 0; i < 3; i++) {
    s += ']';
    try { JSON.parse(s); return s; } catch {}
  }

  // Fix 4: Try wrapping bare key=value in object
  if (!args.trim().startsWith('{')) {
    const attempt = `{${args.trim()}}`;
    try { JSON.parse(attempt); return attempt; } catch {}
  }

  // Give up — return original (LangChain will put it in invalid_tool_calls)
  console.warn(`[api-acp] WARNING: could not repair JSON args: ${args.slice(0, 200)}`);
  return args;
}

/**
 * Try to parse a JSON array string, with repair for common model mistakes.
 * Returns parsed array or null.
 */
function tryParseJsonArray(raw: string): any[] | null {
  const s = raw.trim();

  // Fast path
  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed)) return parsed;
    return null;
  } catch {}

  // Fix: truncated JSON — model may have been cut off mid-array.
  // Try closing open braces/brackets from the end.
  // Count open vs close braces/brackets (outside of strings)
  let inString = false;
  let escape = false;
  let braces = 0;
  let brackets = 0;
  for (const ch of s) {
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') braces++;
    if (ch === '}') braces--;
    if (ch === '[') brackets++;
    if (ch === ']') brackets--;
  }

  let fixed = s;
  // Close unclosed braces then brackets
  for (let i = 0; i < braces; i++) fixed += '}';
  for (let i = 0; i < brackets; i++) fixed += ']';
  try {
    const parsed = JSON.parse(fixed);
    if (Array.isArray(parsed)) {
      console.log(`[api-acp] repaired outer JSON (added ${braces} braces, ${brackets} brackets)`);
      return parsed;
    }
  } catch {}

  return null;
}

// ── Helpers ──────────────────────────────────────────────

/** Extract system messages into a single system prompt. */
function extractSystemPrompt(messages: OpenAIMessage[]): string {
  return messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content ?? '')
    .join('\n\n');
}

/**
 * Convert OpenAI messages array into a single prompt string for the SDK.
 * Handles multi-turn conversations including tool calls and tool results.
 */
function messagesToPrompt(messages: OpenAIMessage[]): string {
  const conversationMsgs = messages.filter((m) => m.role !== 'system');

  // Single user message — just use it directly
  if (conversationMsgs.length === 1 && conversationMsgs[0].role === 'user') {
    return conversationMsgs[0].content ?? '';
  }

  // Multi-turn: format as conversation
  const parts: string[] = [];
  for (const msg of conversationMsgs) {
    if (msg.role === 'user') {
      parts.push(`User: ${msg.content}`);
    } else if (msg.role === 'assistant') {
      if (msg.tool_calls?.length) {
        const calls = msg.tool_calls
          .map((tc) => `[tool_call: ${tc.function.name}(${tc.function.arguments})]`)
          .join('\n');
        parts.push(`Assistant: ${msg.content ?? ''}\n${calls}`);
      } else {
        parts.push(`Assistant: ${msg.content}`);
      }
    } else if (msg.role === 'tool') {
      parts.push(`Tool result (${msg.tool_call_id}): ${msg.content}`);
    }
  }

  return parts.join('\n\n');
}

/**
 * Build a tool-use instruction block to inject into the prompt.
 * This tells the model about the available tools and the expected output format.
 */
function buildToolInstruction(tools: OpenAIToolDef[], toolChoice?: ChatCompletionRequest['tool_choice']): string {
  if (!tools.length) return '';

  const toolDescriptions = tools.map((t) => {
    const params = t.function.parameters
      ? `\n  Parameters: ${JSON.stringify(t.function.parameters)}`
      : '';
    return `- ${t.function.name}: ${t.function.description ?? 'No description'}${params}`;
  }).join('\n');

  let choiceInstruction = '';
  if (toolChoice === 'required') {
    choiceInstruction = '\nYou MUST call at least one tool. Do NOT respond with only text.';
  } else if (toolChoice === 'none') {
    choiceInstruction = '\nDo NOT call any tools. Respond with text only.';
  } else if (typeof toolChoice === 'object' && toolChoice?.type === 'function') {
    choiceInstruction = `\nYou MUST call the tool "${toolChoice.function.name}".`;
  }

  return `
You have access to the following tools. To call a tool, output a JSON array inside a fenced code block:

\`\`\`tool_calls
[{"id":"call_001","type":"function","function":{"name":"TOOL_NAME","arguments":{"param":"value"}}}]
\`\`\`

IMPORTANT: The "arguments" field must be a JSON OBJECT (not a string). Example:
✅ "arguments":{"path":"/src/index.ts","content":"hello"}
❌ "arguments":"{\"path\":\"/src/index.ts\"}"

Available tools:
${toolDescriptions}
${choiceInstruction}

CRITICAL RULES:
1. Output ONLY ONE tool_calls block per response, then STOP IMMEDIATELY.
2. Do NOT simulate, imagine, or fabricate tool results. You will receive REAL results in the next message.
3. Do NOT output any text after the tool_calls block. Your response ENDS at the closing block.
4. You may include a brief explanation BEFORE the tool_calls block.
5. If you don't need any tools, respond normally with text (no tool_calls block).
6. Each tool call MUST have a unique "id" like "call_001", "call_002", etc.`;
}

/**
 * Parse tool_calls from model text output.
 * Handles multiple formats the model might use:
 *   1. ```tool_calls\n[...]\n``` (our custom format)
 *   2. <function_calls>\n[...]\n</function_calls> (Claude XML format)
 * Only parses the FIRST block found — everything after is discarded.
 */
function parseToolCalls(text: string): { toolCalls: OpenAIToolCall[]; textContent: string } | null {
  const patterns: RegExp[] = [
    /```tool_calls\s*\n([\s\S]*?)\n\s*```/,
    /<function_calls>\s*\n?([\s\S]*?)\n?\s*<\/function_calls>/,
  ];

  // Find the earliest match across all patterns
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

  // Use tryParseJsonArray for robust parsing (handles malformed model JSON)
  const parsed = tryParseJsonArray(bestMatch[1]);
  if (!parsed) return null;

  try {
    const toolCalls: OpenAIToolCall[] = parsed.map((tc: any, i: number) => {
      // Get raw arguments value
      const rawArgs = tc.function?.arguments ?? tc.arguments;
      let argsStr: string;
      if (typeof rawArgs === 'string') {
        // Validate & repair the arguments JSON so LangChain can parse it
        argsStr = repairJsonArgs(rawArgs);
      } else {
        argsStr = JSON.stringify(rawArgs ?? {});
      }

      // CRITICAL: Always generate unique IDs. LangGraph's ToolNode skips
      // tool_calls whose ID already has a ToolMessage response in state.
      // If the model reuses "call_001" across responses, subsequent calls
      // are silently dropped. Use timestamp+random to guarantee uniqueness.
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

    // Text BEFORE the first tool_calls block only (discard everything after)
    const textContent = text.slice(0, bestMatch.index).trim();

    return { toolCalls, textContent };
  } catch {
    return null;
  }
}

// ── Route ────────────────────────────────────────────────

chatRoute.post('/', async (c) => {
  const body = await c.req.json<ChatCompletionRequest>();
  const { model: requestedModel, messages, stream, tools, tool_choice } = body;

  // Always log request summary
  console.log(`[api-acp] REQ model=${requestedModel} stream=${stream} tools=${tools?.length ?? 0} msgs=${messages?.length}`);
  // Log each message role and tool calls for debugging
  for (const [i, msg] of messages.entries()) {
    const toolInfo = msg.tool_calls?.length ? ` tool_calls=[${msg.tool_calls.map(tc => tc.function.name).join(',')}]` : '';
    const contentPreview = msg.content ? msg.content.slice(0, 120).replace(/\n/g, '\\n') : '(null)';
    console.log(`[api-acp]   msg[${i}] role=${msg.role}${msg.tool_call_id ? ` tool_call_id=${msg.tool_call_id}` : ''}${toolInfo} content=${contentPreview}${(msg.content?.length ?? 0) > 120 ? '...' : ''}`);
  }

  if (!requestedModel) {
    return c.json({ error: { message: 'model is required', type: 'invalid_request_error' } }, 400);
  }
  if (!messages?.length) {
    return c.json({ error: { message: 'messages is required', type: 'invalid_request_error' } }, 400);
  }

  const { modelId } = resolveModel(requestedModel);
  const systemPrompt = extractSystemPrompt(messages);
  const toolInstruction = tools?.length ? buildToolInstruction(tools, tool_choice) : '';
  const prompt = messagesToPrompt(messages);
  const completionId = makeCompletionId();

  // Combine system prompt + tool instructions
  const fullSystemPrompt = [systemPrompt, toolInstruction].filter(Boolean).join('\n\n');

  const hasTools = !!(tools?.length);

  dbg(`[api-acp] hasTools=${hasTools} promptLen=${prompt.length} sysLen=${fullSystemPrompt.length}`);

  if (stream) {
    return handleStreaming(completionId, requestedModel, modelId, prompt, fullSystemPrompt, hasTools);
  }
  return handleNonStreaming(c, completionId, requestedModel, modelId, prompt, fullSystemPrompt, hasTools);
});

// ── Non-streaming ────────────────────────────────────────

async function handleNonStreaming(
  c: any,
  completionId: string,
  requestedModel: string,
  modelId: string,
  prompt: string,
  systemPrompt: string,
  hasTools: boolean,
) {
  const abortController = new AbortController();
  activeQueries.register(completionId, abortController);

  try {
    const textParts: string[] = [];
    let inputTokens = 0;
    let outputTokens = 0;

    const gen = query({
      prompt,
      options: {
        model: modelId,
        maxTurns: hasTools ? 1 : 50,
        executable: 'node',
        systemPrompt: systemPrompt || undefined,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        abortController,
        ...(hasTools ? { tools: [] } : {}),
      },
    });

    activeQueries.setQuery(completionId, gen);

    for await (const msg of gen) {
      console.log(`[api-acp] SDK msg type=${msg.type}${(msg as any).subtype ? ` subtype=${(msg as any).subtype}` : ''}`);
      if (msg.type === 'assistant') {
        const raw = msg as any;
        if (raw.message?.content) {
          for (const block of raw.message.content) {
            console.log(`[api-acp]   block type=${block.type}${block.type === 'text' ? ` len=${block.text?.length}` : ''}${block.type === 'tool_use' ? ` name=${block.name}` : ''}`);
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
        console.log(`[api-acp]   result len=${raw.result?.length ?? 0}`);
        if (textParts.length === 0 && raw.result) {
          textParts.push(raw.result);
        }
      }
    }

    const fullText = textParts.join('');

    console.log(`[api-acp] RESP non-stream len=${fullText.length} hasTools=${hasTools}`);
    if (hasTools) console.log(`[api-acp] FULL TEXT:\n${fullText}\n[END]`);

    // Check if model output contains tool_calls
    if (hasTools) {
      const parsed = parseToolCalls(fullText);
      console.log(`[api-acp] parsed: ${parsed ? `${parsed.toolCalls.length} calls [${parsed.toolCalls.map(tc => tc.function.name).join(', ')}]` : 'none'}`);
      if (parsed) {
        const resp = {
          id: completionId,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: requestedModel,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: parsed.textContent || null,
                tool_calls: parsed.toolCalls,
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: {
            prompt_tokens: inputTokens,
            completion_tokens: outputTokens,
            total_tokens: inputTokens + outputTokens,
          },
        };
        return c.json(resp);
      }
    }

    return c.json(
      toOpenAIChatCompletion({
        id: completionId,
        model: requestedModel,
        text: fullText,
        promptTokens: inputTokens,
        completionTokens: outputTokens,
      }),
    );
  } catch (err: any) {
    console.error('[api-acp] query error:', err.message);
    return c.json(
      { error: { message: err.message, type: 'server_error' } },
      500,
    );
  } finally {
    activeQueries.remove(completionId);
  }
}

// ── Streaming ────────────────────────────────────────────

async function handleStreaming(
  completionId: string,
  requestedModel: string,
  modelId: string,
  prompt: string,
  systemPrompt: string,
  hasTools: boolean,
) {
  const encoder = new TextEncoder();
  const id = completionId;
  const model = requestedModel;

  const abortController = new AbortController();
  activeQueries.register(completionId, abortController);

  const readableStream = new ReadableStream({
    async start(controller) {
      try {
        // Send initial chunk with role
        controller.enqueue(
          encoder.encode(
            sseEncode(
              toOpenAIStreamChunk({ id, model, delta: { role: 'assistant', content: '' } }),
            ),
          ),
        );

        let inputTokens = 0;
        let outputTokens = 0;
        let accumulatedText = '';

        const gen = query({
          prompt,
          options: {
            model: modelId,
            maxTurns: hasTools ? 1 : 50,
            executable: 'node',
            systemPrompt: systemPrompt || undefined,
            permissionMode: 'bypassPermissions',
            allowDangerouslySkipPermissions: true,
            abortController,
            ...(hasTools ? { tools: [] } : {}),
          },
        });

        activeQueries.setQuery(completionId, gen);

        for await (const msg of gen) {
          console.log(`[api-acp] SDK stream msg type=${msg.type}${(msg as any).subtype ? ` subtype=${(msg as any).subtype}` : ''}`);
          if (msg.type === 'assistant') {
            const raw = msg as any;
            if (raw.message?.content) {
              for (const block of raw.message.content) {
                console.log(`[api-acp]   stream block type=${block.type}${block.type === 'text' ? ` len=${block.text?.length}` : ''}${block.type === 'tool_use' ? ` name=${block.name}` : ''}`);
                if (block.type === 'text') {
                  accumulatedText += block.text;

                  // In tool mode, buffer all text to check for tool_calls at the end
                  if (!hasTools) {
                    controller.enqueue(
                      encoder.encode(
                        sseEncode(
                          toOpenAIStreamChunk({ id, model, delta: { content: block.text } }),
                        ),
                      ),
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
                controller.enqueue(
                  encoder.encode(
                    sseEncode(
                      toOpenAIStreamChunk({ id, model, delta: { content: raw.result } }),
                    ),
                  ),
                );
              }
            }
          }
        }

        // For tool mode, check if we got tool_calls and emit them
        if (hasTools && accumulatedText) {
          const parsed = parseToolCalls(accumulatedText);
          console.log(`[api-acp] stream parsed: ${parsed ? `${parsed.toolCalls.length} calls [${parsed.toolCalls.map(tc => tc.function.name).join(', ')}]` : 'none'}`);
          if (parsed) {
            // Send text content if any
            if (parsed.textContent) {
              controller.enqueue(
                encoder.encode(
                  sseEncode(
                    toOpenAIStreamChunk({ id, model, delta: { content: parsed.textContent } }),
                  ),
                ),
              );
            }
            // Send tool_calls as a single chunk
            controller.enqueue(
              encoder.encode(
                sseEncode({
                  id,
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: parsed.toolCalls.map((tc, i) => ({
                          index: i,
                          id: tc.id,
                          type: 'function',
                          function: { name: tc.function.name, arguments: tc.function.arguments },
                        })),
                      },
                      finish_reason: null,
                    },
                  ],
                }),
              ),
            );
          } else {
            // No tool_calls found, just send the text
            controller.enqueue(
              encoder.encode(
                sseEncode(toOpenAIStreamChunk({ id, model, delta: { content: accumulatedText } })),
              ),
            );
          }
        }

        // Send final chunk with finish_reason and usage
        const finishReason = hasTools && parseToolCalls(accumulatedText) ? 'tool_calls' : 'stop';
        controller.enqueue(
          encoder.encode(
            sseEncode(
              toOpenAIStreamChunk({
                id,
                model,
                delta: {},
                finishReason,
                usage: { promptTokens: inputTokens, completionTokens: outputTokens },
              }),
            ),
          ),
        );

        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      } catch (err: any) {
        console.error('[api-acp] stream error:', err.message);
        controller.error(err);
      } finally {
        activeQueries.remove(completionId);
      }
    },
    cancel() {
      // Client disconnected — cancel the in-flight query
      console.log(`[api-acp] client disconnected, cancelling ${completionId}`);
      activeQueries.cancel(completionId);
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
