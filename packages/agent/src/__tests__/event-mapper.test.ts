import { describe, it, expect } from 'bun:test';
import { PipelineEventMapper, mapAgentMessage } from '../core/event-mapper.js';
import type { CLIMessage } from '@funny/core/agents';

// ── Helpers: build CLIMessage-like objects ───────────────────────

function makeSystemInit(sessionId = 'sess-1', model = 'sonnet'): CLIMessage {
  return {
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    model,
  } as CLIMessage;
}

function makeAssistantText(text: string, messageId = 'msg-1'): CLIMessage {
  return {
    type: 'assistant',
    message: {
      id: messageId,
      content: [{ type: 'text', text }],
    },
  } as CLIMessage;
}

function makeAssistantToolUse(name: string, input: unknown = {}, id = 'tu-1'): CLIMessage {
  return {
    type: 'assistant',
    message: {
      id: 'msg-tu',
      content: [{ type: 'tool_use', id, name, input }],
    },
  } as CLIMessage;
}

function makeResult(isError: boolean, result = 'done'): CLIMessage {
  return {
    type: 'result',
    is_error: isError,
    subtype: 'result',
    result,
    duration_ms: 1000,
    num_turns: 5,
    total_cost_usd: 0.05,
    errors: isError ? ['some error'] : undefined,
  } as CLIMessage;
}

function makeUserMessage(): CLIMessage {
  return {
    type: 'user',
    message: { content: 'tool result' },
  } as CLIMessage;
}

// ── Stateless mapAgentMessage tests ─────────────────────────────

describe('mapAgentMessage (stateless)', () => {
  it('maps system init to pipeline.started', () => {
    const event = mapAgentMessage(makeSystemInit('s1', 'opus'), 'req-1');
    expect(event).not.toBeNull();
    expect(event!.event_type).toBe('pipeline.started');
    expect(event!.request_id).toBe('req-1');
    expect(event!.data.session_id).toBe('s1');
    expect(event!.data.model).toBe('opus');
  });

  it('maps Task tool_use to pipeline.agent.started', () => {
    const event = mapAgentMessage(makeAssistantToolUse('Task', { prompt: 'test' }, 'tu-42'), 'req-2');
    expect(event).not.toBeNull();
    expect(event!.event_type).toBe('pipeline.agent.started');
    expect(event!.data.tool_use_id).toBe('tu-42');
  });

  it('maps dispatch_agent tool_use to pipeline.agent.started', () => {
    const event = mapAgentMessage(makeAssistantToolUse('dispatch_agent'), 'req-3');
    expect(event).not.toBeNull();
    expect(event!.event_type).toBe('pipeline.agent.started');
  });

  it('returns null for regular assistant text (no lifecycle event)', () => {
    const event = mapAgentMessage(makeAssistantText('Running tests now'), 'req-4');
    expect(event).toBeNull();
  });

  it('maps result success to pipeline.completed', () => {
    const event = mapAgentMessage(makeResult(false, 'All passed'), 'req-5');
    expect(event).not.toBeNull();
    expect(event!.event_type).toBe('pipeline.completed');
    expect(event!.data.result).toBe('All passed');
  });

  it('maps result error to pipeline.failed', () => {
    const event = mapAgentMessage(makeResult(true, 'Crash'), 'req-6');
    expect(event).not.toBeNull();
    expect(event!.event_type).toBe('pipeline.failed');
    expect(event!.data.result).toBe('Crash');
  });

  it('maps user message to null', () => {
    const event = mapAgentMessage(makeUserMessage(), 'req-7');
    expect(event).toBeNull();
  });

  it('maps non-init system message to null', () => {
    const msg = { type: 'system', subtype: 'other' } as CLIMessage;
    const event = mapAgentMessage(msg, 'req-8');
    expect(event).toBeNull();
  });
});

// ── Stateful PipelineEventMapper tests ──────────────────────────

describe('PipelineEventMapper', () => {
  it('tracks correction count', () => {
    const mapper = new PipelineEventMapper('req-100');

    // Start: system init
    mapper.map(makeSystemInit());

    // Agent started
    mapper.map(makeAssistantToolUse('Task'));

    expect(mapper.corrections).toBe(0);
    expect(mapper.isCorrecting).toBe(false);
  });

  it('detects correction cycle from "correction cycle" text', () => {
    const mapper = new PipelineEventMapper('req-101');

    // Agent starts first
    mapper.map(makeAssistantToolUse('Task'));

    // Text signals correction
    const event = mapper.map(makeAssistantText('Starting correction cycle 1: re-running failing agents'));
    expect(event).not.toBeNull();
    expect(event!.event_type).toBe('pipeline.correcting');
    expect(event!.data.correction_number).toBe(1);
    expect(mapper.corrections).toBe(1);
    expect(mapper.isCorrecting).toBe(true);
  });

  it('detects correction from "re-running the failing" text', () => {
    const mapper = new PipelineEventMapper('req-102');

    mapper.map(makeAssistantToolUse('Task'));

    const event = mapper.map(makeAssistantText('Re-running the failing agents after applying fixes'));
    expect(event).not.toBeNull();
    expect(event!.event_type).toBe('pipeline.correcting');
  });

  it('detects correction from "fixing ... re-run" text', () => {
    const mapper = new PipelineEventMapper('req-103');

    mapper.map(makeAssistantToolUse('Task'));

    const event = mapper.map(makeAssistantText('Fixed the type errors, will re-run the type checker'));
    expect(event).not.toBeNull();
    expect(event!.event_type).toBe('pipeline.correcting');
  });

  it('does NOT detect correction if no agents have started', () => {
    const mapper = new PipelineEventMapper('req-104');

    // Text mentions correction but no agents started → null (no lifecycle event)
    const event = mapper.map(makeAssistantText('Starting correction cycle'));
    expect(event).toBeNull();
  });

  it('includes corrections_count in completed event', () => {
    const mapper = new PipelineEventMapper('req-105');

    mapper.map(makeAssistantToolUse('Task'));
    mapper.map(makeAssistantText('Correction cycle 1'));

    const event = mapper.map(makeResult(false, 'done'));
    expect(event).not.toBeNull();
    expect(event!.event_type).toBe('pipeline.completed');
    expect(event!.data.corrections_count).toBe(1);
  });

  it('resets correction state on result', () => {
    const mapper = new PipelineEventMapper('req-106');

    mapper.map(makeAssistantToolUse('Task'));
    mapper.map(makeAssistantText('Correction cycle 1'));
    expect(mapper.isCorrecting).toBe(true);

    mapper.map(makeResult(false));
    expect(mapper.isCorrecting).toBe(false);
  });

  it('does not double-emit correcting for same cycle', () => {
    const mapper = new PipelineEventMapper('req-107');

    mapper.map(makeAssistantToolUse('Task'));

    // First correction text → pipeline.correcting
    const first = mapper.map(makeAssistantText('Correction cycle 1'));
    expect(first!.event_type).toBe('pipeline.correcting');

    // Second correction text while still correcting → null (no lifecycle event, already correcting)
    const second = mapper.map(makeAssistantText('Still in correction cycle 1'));
    expect(second).toBeNull();
  });
});
