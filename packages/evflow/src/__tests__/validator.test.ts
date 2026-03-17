import { describe, test, expect } from 'bun:test';

import type { EventModelData, ElementDef } from '../types.js';
import { validate } from '../validator.js';

function model(
  elements: Record<string, ElementDef>,
  sequences: EventModelData['sequences'] = [],
  slices: EventModelData['slices'] = [],
): EventModelData {
  return {
    name: 'Test',
    elements: new Map(Object.entries(elements)),
    sequences,
    slices,
  };
}

describe('validate', () => {
  test('returns no issues for a valid model', () => {
    const m = model(
      {
        AddItem: { kind: 'command', name: 'AddItem', fields: { id: 'string' } },
        ItemAdded: { kind: 'event', name: 'ItemAdded', fields: { id: 'string' } },
        CartView: {
          kind: 'readModel',
          name: 'CartView',
          from: ['ItemAdded'],
          fields: { id: 'string' },
        },
        AutoAdd: { kind: 'automation', name: 'AutoAdd', on: 'ItemAdded', triggers: 'AddItem' },
      },
      [{ name: 'Flow', steps: ['AddItem', 'ItemAdded'] }],
    );
    const issues = validate(m);
    expect(issues.filter((i) => i.severity === 'error')).toHaveLength(0);
  });

  test('detects READ_MODEL_UNKNOWN_SOURCE', () => {
    const m = model({
      CartView: { kind: 'readModel', name: 'CartView', from: ['NonExistent'], fields: {} },
    });
    const issues = validate(m);
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'READ_MODEL_UNKNOWN_SOURCE', severity: 'error' }),
    );
  });

  test('detects READ_MODEL_INVALID_SOURCE when source is not an event', () => {
    const m = model({
      AddItem: { kind: 'command', name: 'AddItem', fields: {} },
      CartView: { kind: 'readModel', name: 'CartView', from: ['AddItem'], fields: {} },
    });
    const issues = validate(m);
    expect(issues).toContainEqual(expect.objectContaining({ code: 'READ_MODEL_INVALID_SOURCE' }));
  });

  test('detects AUTOMATION_UNKNOWN_EVENT', () => {
    const m = model({
      DoSomething: { kind: 'command', name: 'DoSomething', fields: {} },
      Auto: { kind: 'automation', name: 'Auto', on: 'GhostEvent', triggers: 'DoSomething' },
    });
    const issues = validate(m);
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'AUTOMATION_UNKNOWN_EVENT', severity: 'error' }),
    );
  });

  test('detects AUTOMATION_UNKNOWN_COMMAND', () => {
    const m = model({
      SomeEvent: { kind: 'event', name: 'SomeEvent', fields: {} },
      Auto: { kind: 'automation', name: 'Auto', on: 'SomeEvent', triggers: 'GhostCommand' },
    });
    const issues = validate(m);
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'AUTOMATION_UNKNOWN_COMMAND', severity: 'error' }),
    );
  });

  test('detects AUTOMATION_INVALID_EVENT when on is not an event', () => {
    const m = model({
      Cmd: { kind: 'command', name: 'Cmd', fields: {} },
      Auto: { kind: 'automation', name: 'Auto', on: 'Cmd', triggers: 'Cmd' },
    });
    const issues = validate(m);
    expect(issues).toContainEqual(expect.objectContaining({ code: 'AUTOMATION_INVALID_EVENT' }));
  });

  test('detects SEQUENCE_UNKNOWN_ELEMENT', () => {
    const m = model({ A: { kind: 'command', name: 'A', fields: {} } }, [
      { name: 'Flow', steps: ['A', 'B'] },
    ]);
    const issues = validate(m);
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'SEQUENCE_UNKNOWN_ELEMENT', severity: 'error' }),
    );
  });

  test('detects SLICE_UNKNOWN_ELEMENT', () => {
    const m = model(
      { A: { kind: 'command', name: 'A', fields: {} } },
      [],
      [
        {
          name: 'Slice',
          ui: 'Page',
          commands: ['A'],
          events: ['Nope'],
          readModels: [],
          automations: [],
        },
      ],
    );
    const issues = validate(m);
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'SLICE_UNKNOWN_ELEMENT', severity: 'error' }),
    );
  });

  test('warns on ORPHAN_EVENT', () => {
    const m = model(
      {
        Cmd: { kind: 'command', name: 'Cmd', fields: {} },
        Evt: { kind: 'event', name: 'Evt', fields: {} },
      },
      [{ name: 'Flow', steps: ['Cmd'] }], // Evt not in any sequence
    );
    const issues = validate(m);
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'ORPHAN_EVENT', severity: 'warning' }),
    );
  });

  test('warns on ORPHAN_COMMAND', () => {
    const m = model(
      {
        Cmd: { kind: 'command', name: 'Cmd', fields: {} },
        Evt: { kind: 'event', name: 'Evt', fields: {} },
      },
      [{ name: 'Flow', steps: ['Evt'] }], // Cmd not in any sequence
    );
    const issues = validate(m);
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'ORPHAN_COMMAND', severity: 'warning' }),
    );
  });

  test('does not warn about orphans when no sequences exist', () => {
    const m = model({
      Cmd: { kind: 'command', name: 'Cmd', fields: {} },
      Evt: { kind: 'event', name: 'Evt', fields: {} },
    });
    const issues = validate(m);
    const orphans = issues.filter((i) => i.code === 'ORPHAN_EVENT' || i.code === 'ORPHAN_COMMAND');
    expect(orphans).toHaveLength(0);
  });

  test('warns on DUPLICATE_SEQUENCE_NAME', () => {
    const m = model({ A: { kind: 'command', name: 'A', fields: {} } }, [
      { name: 'Same', steps: ['A'] },
      { name: 'Same', steps: ['A'] },
    ]);
    const issues = validate(m);
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'DUPLICATE_SEQUENCE_NAME', severity: 'warning' }),
    );
  });

  test('validates automation with multiple triggers', () => {
    const m = model({
      Evt: { kind: 'event', name: 'Evt', fields: {} },
      Cmd1: { kind: 'command', name: 'Cmd1', fields: {} },
      Auto: { kind: 'automation', name: 'Auto', on: 'Evt', triggers: ['Cmd1', 'GhostCmd'] },
    });
    const issues = validate(m);
    expect(issues).toContainEqual(
      expect.objectContaining({
        code: 'AUTOMATION_UNKNOWN_COMMAND',
        message: expect.stringContaining('GhostCmd'),
      }),
    );
  });
});
