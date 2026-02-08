import { nanoid } from 'nanoid';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { wsBroker } from './ws-broker.js';
import type { WSEvent, ClaudeModel, PermissionMode } from '@a-parallel/shared';
import {
  ClaudeProcess,
  type CLIMessage,
} from './claude-process.js';

// Active running agents (in-memory only)
const activeAgents = new Map<string, ClaudeProcess>();

function emitWS(threadId: string, type: WSEvent['type'], data: unknown) {
  console.log(`[agent:ws] Emitting ${type} for thread ${threadId} (${wsBroker.clientCount} clients)`);
  wsBroker.emit({ type, threadId, data });
}

const PERMISSION_MAP: Record<PermissionMode, string> = {
  plan: 'plan',
  autoEdit: 'acceptEdits',
  confirmEdit: 'default',
};

const MODEL_MAP: Record<ClaudeModel, string> = {
  sonnet: 'claude-sonnet-4-5-20250929',
  opus: 'claude-opus-4-6',
  haiku: 'claude-haiku-4-5-20251001',
};

// ── Message handler ────────────────────────────────────────────────

/**
 * Track whether we received a result message before the process exited.
 * Keyed by threadId.
 */
const resultReceived = new Set<string>();

/**
 * Track threads that were manually stopped so the exit handler
 * doesn't overwrite the 'stopped' status with 'failed'.
 */
const manuallyStopped = new Set<string>();

/**
 * Track the current assistant message DB ID per thread.
 * The CLI sends multiple `assistant` messages during streaming, each with
 * the FULL content so far (not deltas). We upsert a single DB row and
 * send a stable messageId to the client so it can replace instead of append.
 */
const currentAssistantMsgId = new Map<string, string>();

/**
 * Track tool_use block IDs that have already been processed per thread.
 * The CLI streams cumulative content, so the same tool_use blocks appear
 * in multiple assistant messages. We deduplicate using the CLI's block ID.
 * Maps threadId → (cliToolUseId → our toolCallId) for matching tool results.
 */
const processedToolUseIds = new Map<string, Map<string, string>>();

/**
 * Map CLI message IDs to our DB message IDs per thread.
 * The CLI sends the same assistant message multiple times (cumulative streaming).
 * After a tool_use deletes currentAssistantMsgId, we still need to find the
 * DB message for the same CLI message to avoid creating duplicates.
 * Maps threadId → (cliMessageId → dbMessageId).
 */
const cliToDbMsgId = new Map<string, Map<string, string>>();

function handleCLIMessage(threadId: string, msg: CLIMessage): void {
  console.log(`[agent:handler] Received msg type=${msg.type} for thread ${threadId}`);

  // System init — capture session ID and broadcast init info
  if (msg.type === 'system' && 'subtype' in msg && msg.subtype === 'init') {
    console.log(`[agent:handler] System init — session_id=${msg.session_id}`);
    db.update(schema.threads)
      .set({ sessionId: msg.session_id })
      .where(eq(schema.threads.id, threadId))
      .run();

    emitWS(threadId, 'agent:init', {
      tools: msg.tools ?? [],
      cwd: msg.cwd ?? '',
      model: msg.model ?? '',
    });
    return;
  }

  // Assistant messages — text and tool calls
  if (msg.type === 'assistant') {
    const cliMsgId = msg.message.id; // stable across cumulative streaming updates
    console.log(`[agent:handler] Assistant msg ${cliMsgId} with ${msg.message.content.length} block(s)`);

    // Get or init the CLI→DB message ID map for this thread
    const cliMap = cliToDbMsgId.get(threadId) ?? new Map<string, string>();
    cliToDbMsgId.set(threadId, cliMap);

    // Combine all text blocks into a single string
    const textContent = msg.message.content
      .filter((b): b is { type: 'text'; text: string } => 'text' in b && !!b.text)
      .map((b) => b.text)
      .join('\n\n');

    if (textContent) {
      // Reuse existing DB message: first check currentAssistantMsgId, then CLI map
      let msgId = currentAssistantMsgId.get(threadId) || cliMap.get(cliMsgId);
      if (msgId) {
        // Update existing row (streaming update — same turn, fuller content)
        console.log(`[agent:handler] Updating msg ${msgId} (${textContent.length} chars)`);
        db.update(schema.messages)
          .set({ content: textContent, timestamp: new Date().toISOString() })
          .where(eq(schema.messages.id, msgId))
          .run();
      } else {
        // First text for this turn — insert new row
        msgId = nanoid();
        console.log(`[agent:handler] New assistant msg ${msgId} (${textContent.length} chars)`);
        db.insert(schema.messages)
          .values({
            id: msgId,
            threadId,
            role: 'assistant',
            content: textContent,
            timestamp: new Date().toISOString(),
          })
          .run();
      }
      currentAssistantMsgId.set(threadId, msgId);
      cliMap.set(cliMsgId, msgId);

      emitWS(threadId, 'agent:message', {
        messageId: msgId,
        role: 'assistant',
        content: textContent,
      });
    }

    // Handle tool calls (deduplicate — streaming sends cumulative content)
    const seen = processedToolUseIds.get(threadId) ?? new Map<string, string>();
    for (const block of msg.message.content) {
      if ('type' in block && block.type === 'tool_use') {
        if (seen.has(block.id)) continue; // already processed

        console.log(`[agent:handler] Tool use: ${block.name}`);
        const toolCallId = nanoid();
        seen.set(block.id, toolCallId);

        // Ensure there's always a parent assistant message for tool calls
        let parentMsgId = currentAssistantMsgId.get(threadId) || cliMap.get(cliMsgId);
        if (!parentMsgId) {
          parentMsgId = nanoid();
          db.insert(schema.messages)
            .values({
              id: parentMsgId,
              threadId,
              role: 'assistant',
              content: '',
              timestamp: new Date().toISOString(),
            })
            .run();
          // Notify client so it creates the message before tool calls arrive
          emitWS(threadId, 'agent:message', {
            messageId: parentMsgId,
            role: 'assistant',
            content: '',
          });
        }
        currentAssistantMsgId.set(threadId, parentMsgId);
        cliMap.set(cliMsgId, parentMsgId);

        db.insert(schema.toolCalls)
          .values({
            id: toolCallId,
            messageId: parentMsgId,
            name: block.name,
            input: JSON.stringify(block.input),
          })
          .run();

        emitWS(threadId, 'agent:tool_call', {
          toolCallId,
          messageId: parentMsgId,
          name: block.name,
          input: block.input,
        });

        // Reset currentAssistantMsgId — next CLI message's text should be a new DB message
        // But cliMap keeps the mapping so cumulative updates of THIS message still work
        currentAssistantMsgId.delete(threadId);
      }
    }
    processedToolUseIds.set(threadId, seen);
    return;
  }

  // User messages — tool results (output from tool executions)
  if (msg.type === 'user') {
    const seen = processedToolUseIds.get(threadId);
    if (seen && msg.message.content) {
      for (const block of msg.message.content) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          const toolCallId = seen.get(block.tool_use_id);
          if (toolCallId && block.content) {
            console.log(`[agent:handler] Tool result for ${block.tool_use_id} → ${toolCallId} (${block.content.length} chars)`);
            // Update DB
            db.update(schema.toolCalls)
              .set({ output: block.content })
              .where(eq(schema.toolCalls.id, toolCallId))
              .run();
            // Notify clients
            emitWS(threadId, 'agent:tool_output', {
              toolCallId,
              output: block.content,
            });
          }
        }
      }
    }
    return;
  }

  // Result — agent finished
  if (msg.type === 'result') {
    const raw = msg as any;
    console.log(`[agent:handler] Result — subtype=${msg.subtype}, cost=$${msg.total_cost_usd}, duration=${msg.duration_ms}ms`);
    console.log(`[agent:handler] Result details — stop_reason=${raw.stop_reason ?? 'N/A'}, num_turns=${msg.num_turns}, is_error=${msg.is_error}`);
    console.log(`[agent:handler] Result text (first 200 chars): ${msg.result?.substring(0, 200) ?? '(none)'}`);
    resultReceived.add(threadId);
    currentAssistantMsgId.delete(threadId);
    processedToolUseIds.delete(threadId);

    const finalStatus = msg.subtype === 'success' ? 'completed' : 'failed';

    db.update(schema.threads)
      .set({
        status: finalStatus,
        cost: msg.total_cost_usd,
        completedAt: new Date().toISOString(),
      })
      .where(eq(schema.threads.id, threadId))
      .run();

    // Don't save msg.result to DB — already captured in the last assistant message

    emitWS(threadId, 'agent:result', {
      result: msg.result,
      cost: msg.total_cost_usd,
      duration: msg.duration_ms,
      status: finalStatus,
    });

    emitWS(threadId, 'agent:status', { status: finalStatus });
  }
}

// ── Public API (same interface as before) ──────────────────────────

export async function startAgent(
  threadId: string,
  prompt: string,
  cwd: string,
  model: ClaudeModel = 'sonnet',
  permissionMode: PermissionMode = 'autoEdit',
  images?: any[]
): Promise<void> {
  console.log('========================================');
  console.log('[agent] >>> startAgent() CALLED <<<');
  console.log(`[agent] threadId=${threadId}`);
  console.log(`[agent] model=${model}`);
  console.log(`[agent] cwd=${cwd}`);
  console.log(`[agent] prompt=${prompt}`);
  console.log(`[agent] images=${images?.length ?? 0}`);
  console.log('========================================');

  // Clear stale state from previous runs
  currentAssistantMsgId.delete(threadId);
  processedToolUseIds.delete(threadId);
  cliToDbMsgId.delete(threadId);
  resultReceived.delete(threadId);
  manuallyStopped.delete(threadId);

  // Update thread status
  db.update(schema.threads)
    .set({ status: 'running' })
    .where(eq(schema.threads.id, threadId))
    .run();

  emitWS(threadId, 'agent:status', { status: 'running' });

  // Save user message
  db.insert(schema.messages)
    .values({
      id: nanoid(),
      threadId,
      role: 'user',
      content: prompt,
      images: images ? JSON.stringify(images) : null,
      timestamp: new Date().toISOString(),
    })
    .run();

  // User message is NOT broadcast via WS — the client adds it optimistically
  // and polling will sync from DB. Broadcasting caused triple-display.

  // Check if we're resuming a previous session
  const thread = db
    .select()
    .from(schema.threads)
    .where(eq(schema.threads.id, threadId))
    .get();

  // Spawn claude CLI process
  console.log(`[agent] Starting agent for thread ${threadId}, model=${model}, cwd=${cwd}`);
  console.log(`[agent] Prompt: ${prompt}`);
  const claudeProcess = new ClaudeProcess({
    prompt,
    cwd,
    model: MODEL_MAP[model],
    permissionMode: PERMISSION_MAP[permissionMode],
    allowedTools: ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'],
    maxTurns: 30,
    sessionId: thread?.sessionId ?? undefined,
    images,
  });

  activeAgents.set(threadId, claudeProcess);
  resultReceived.delete(threadId);
  processedToolUseIds.delete(threadId);

  // Handle messages from the CLI
  claudeProcess.on('message', (msg: CLIMessage) => {
    handleCLIMessage(threadId, msg);
  });

  // Handle errors
  claudeProcess.on('error', (err: Error) => {
    console.error(`[agent] Error in thread ${threadId}:`, err);

    // Don't overwrite status if manually stopped or result already received
    if (!resultReceived.has(threadId) && !manuallyStopped.has(threadId)) {
      db.update(schema.threads)
        .set({ status: 'failed', completedAt: new Date().toISOString() })
        .where(eq(schema.threads.id, threadId))
        .run();

      emitWS(threadId, 'agent:error', { error: err.message });
      emitWS(threadId, 'agent:status', { status: 'failed' });
    }
  });

  // Handle process exit
  claudeProcess.on('exit', (code: number | null) => {
    console.log(`[agent] Process exit for thread ${threadId}, code=${code}, resultReceived=${resultReceived.has(threadId)}, manuallyStopped=${manuallyStopped.has(threadId)}`);
    activeAgents.delete(threadId);

    // If manually stopped, don't overwrite the 'stopped' status
    if (manuallyStopped.has(threadId)) {
      manuallyStopped.delete(threadId);
      resultReceived.delete(threadId);
      return;
    }

    // If the process exited without sending a result, mark as failed
    if (!resultReceived.has(threadId)) {
      db.update(schema.threads)
        .set({ status: 'failed', completedAt: new Date().toISOString() })
        .where(eq(schema.threads.id, threadId))
        .run();

      emitWS(threadId, 'agent:error', {
        error: 'Agent process exited unexpectedly without a result',
      });
      emitWS(threadId, 'agent:status', { status: 'failed' });
    }

    resultReceived.delete(threadId);
  });

  // Start the process
  console.log(`[agent] Calling claudeProcess.start()...`);
  claudeProcess.start();
  console.log(`[agent] Process started for thread ${threadId}`);
}

export async function stopAgent(threadId: string): Promise<void> {
  const claudeProcess = activeAgents.get(threadId);
  if (claudeProcess) {
    manuallyStopped.add(threadId);
    try {
      await claudeProcess.kill();
    } catch (e) {
      console.error(`[agent] Error killing process for thread ${threadId}:`, e);
    }
    activeAgents.delete(threadId);
  }

  db.update(schema.threads)
    .set({ status: 'stopped', completedAt: new Date().toISOString() })
    .where(eq(schema.threads.id, threadId))
    .run();

  emitWS(threadId, 'agent:status', { status: 'stopped' });
}

export function isAgentRunning(threadId: string): boolean {
  return activeAgents.has(threadId);
}
