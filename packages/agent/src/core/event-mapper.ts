/**
 * Map CLIMessage events from the agent process to PipelineEvents.
 *
 * PipelineEventMapper is stateful per-request: it tracks whether agents
 * have been started and detects correction cycles from assistant text.
 *
 * NOTE: UI rendering is handled by pipeline.cli_message events (raw CLIMessages
 * forwarded to the server's ingest mapper). This mapper only produces
 * LIFECYCLE events used internally by the pipeline service (cleanup,
 * manifest writer, idempotency release, etc.).
 */

import type { CLIMessage } from '@funny/core/agents';
import type { PipelineEvent, PipelineEventType } from './types.js';

// ── Correction detection patterns ────────────────────────────────

const CORRECTION_PATTERNS = [
  /correction\s+cycle/i,
  /re-?runn?ing\s+(the\s+)?failing/i,
  /applying\s+(the\s+)?fix/i,
  /fix(ing|ed)\s+.*\bre-?run/i,
  /agents?\s+(that\s+)?failed.*re-?run/i,
  /\bcorrection\s+(round|attempt|pass)\b/i,
];

function isCorrectingText(text: string): boolean {
  return CORRECTION_PATTERNS.some((pattern) => pattern.test(text));
}

// ── Helpers ──────────────────────────────────────────────────────

function makeEvent(
  eventType: PipelineEventType,
  requestId: string,
  data: Record<string, unknown> = {},
): PipelineEvent {
  return {
    event_type: eventType,
    request_id: requestId,
    timestamp: new Date().toISOString(),
    data,
  };
}

// ── Stateful mapper ──────────────────────────────────────────────

export class PipelineEventMapper {
  private agentsStarted = 0;
  private agentsCompleted = 0;
  private inCorrectionCycle = false;
  private correctionCount = 0;

  constructor(private requestId: string) {}

  get corrections(): number {
    return this.correctionCount;
  }

  get isCorrecting(): boolean {
    return this.inCorrectionCycle;
  }

  /**
   * Translate a CLIMessage into zero or one PipelineEvent.
   *
   * Only produces LIFECYCLE events (started, completed, failed, correcting,
   * agent.started). UI-facing events are handled via pipeline.cli_message.
   */
  map(msg: CLIMessage): PipelineEvent | null {
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') {
          return makeEvent('pipeline.started', this.requestId, {
            session_id: msg.session_id,
            model: msg.model,
          });
        }
        return null;

      case 'assistant': {
        const toolUses = msg.message.content.filter(
          (c): c is { type: 'tool_use'; id: string; name: string; input: unknown } =>
            c.type === 'tool_use',
        );

        // Track sub-agent launches for correction detection
        for (const tu of toolUses) {
          if (tu.name === 'Task' || tu.name === 'dispatch_agent') {
            this.agentsStarted++;
            return makeEvent('pipeline.agent.started', this.requestId, {
              tool_use_id: tu.id,
              agent_name: tu.name,
              input: tu.input,
            });
          }
        }

        // Detect correction cycle from text content
        const textBlocks = msg.message.content.filter(
          (c): c is { type: 'text'; text: string } => c.type === 'text',
        );
        if (textBlocks.length > 0 && this.agentsStarted > 0) {
          const fullText = textBlocks.map((t) => t.text).join('\n');
          if (isCorrectingText(fullText) && !this.inCorrectionCycle) {
            this.inCorrectionCycle = true;
            this.correctionCount++;
            return makeEvent('pipeline.correcting', this.requestId, {
              correction_number: this.correctionCount,
              text: fullText,
            });
          }
        }

        // No lifecycle event for regular assistant messages —
        // UI rendering is handled by pipeline.cli_message
        return null;
      }

      case 'result':
        // Reset correction state on completion
        this.inCorrectionCycle = false;

        if (msg.is_error) {
          return makeEvent('pipeline.failed', this.requestId, {
            subtype: msg.subtype,
            result: msg.result,
            errors: msg.errors,
            duration_ms: msg.duration_ms,
            cost_usd: msg.total_cost_usd,
            corrections_count: this.correctionCount,
          });
        }
        return makeEvent('pipeline.completed', this.requestId, {
          subtype: msg.subtype,
          result: msg.result,
          duration_ms: msg.duration_ms,
          num_turns: msg.num_turns,
          cost_usd: msg.total_cost_usd,
          corrections_count: this.correctionCount,
        });

      case 'user':
        // Tool results — no lifecycle event needed
        return null;

      default:
        return null;
    }
  }
}

// ── Backward-compatible stateless function ───────────────────────

/**
 * Stateless wrapper — for simple use cases that don't need correction tracking.
 */
export function mapAgentMessage(
  msg: CLIMessage,
  requestId: string,
): PipelineEvent | null {
  // Create a one-shot mapper (no state carried between calls)
  const mapper = new PipelineEventMapper(requestId);
  return mapper.map(msg);
}
