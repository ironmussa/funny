import { describe, expect, test } from 'vitest';

import {
  RUNNER_OPERATION_EVENT_TYPES,
  mapRunnerOperation,
  mapRunnerOperationOutcome,
  normalizeRunnerOperationValue,
} from '../../services/grpc-operations-adapter.js';

describe('GrpcOperationsAdapter mapping', () => {
  test('maps every declared application operation to exactly one protobuf field', () => {
    const mappings = RUNNER_OPERATION_EVENT_TYPES.map((eventType) =>
      mapRunnerOperation(eventType, { payload: {} }),
    );
    expect(mappings).toHaveLength(RUNNER_OPERATION_EVENT_TYPES.length);
    expect(mappings.every(({ kind }) => typeof kind === 'string' && kind.length > 0)).toBe(true);
  });

  test('projects legacy and principal-derived fields before protobuf encoding', () => {
    expect(
      normalizeRunnerOperationValue('insertMessage', {
        threadId: 'thread-1',
        role: 'assistant',
        content: 'hello',
        images: ['a'],
        ignored: undefined,
      }),
    ).toEqual({
      threadId: 'thread-1',
      role: 'assistant',
      content: 'hello',
      imagesJson: ['a'],
    });
    expect(
      normalizeRunnerOperationValue('createPermissionRule', {
        userId: 'untrusted',
        projectPath: '/repo',
        toolName: 'Bash',
        decision: 'allow',
      }),
    ).toEqual({ projectPath: '/repo', toolName: 'Bash', decision: 'allow' });
  });

  test('maps all supported outcome envelopes back to facade results', () => {
    expect(
      mapRunnerOperationOutcome('getThread', {
        thread: { value: { id: 'thread-1' } },
      }),
    ).toEqual({ type: 'data:get_thread_response', thread: { id: 'thread-1' } });
    expect(
      mapRunnerOperationOutcome('insertMessage', {
        insertedRecord: { id: 'message-1' },
      }),
    ).toEqual({ messageId: 'message-1' });
    expect(
      mapRunnerOperationOutcome('insertToolCall', {
        insertedRecord: { id: 'tool-1' },
      }),
    ).toEqual({ toolCallId: 'tool-1' });
    expect(
      mapRunnerOperationOutcome('deleteMessagesAfter', {
        deletedRecords: { count: '3' },
      }),
    ).toEqual({ deletedCount: 3 });
    expect(mapRunnerOperationOutcome('custom', { operationResponse: { value: 1 } })).toEqual({
      value: 1,
    });
  });
});
