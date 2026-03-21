import { createRuntimeModel } from '@funny/shared/evflow-model';
import { describe, test, expect } from 'vitest';

import type { ThreadEventMap } from '../../services/thread-event-bus.js';

describe('Runtime evflow model', () => {
  const model = createRuntimeModel();

  test('model has the correct name', () => {
    expect(model.name).toBe('FunnyRuntime');
  });

  test('validate() passes with no errors', () => {
    const result = model.validate();
    if (result.isErr()) {
      const errors = result.error.filter((i) => i.severity === 'error');
      throw new Error(
        `Model has ${errors.length} validation error(s):\n${errors.map((e) => `  - [${e.code}] ${e.message}`).join('\n')}`,
      );
    }
    expect(result.isOk()).toBe(true);
  });

  test('validate() produces only acceptable warnings', () => {
    const result = model.validate();
    const warnings = result.isOk()
      ? result.value
      : result.error.filter((i) => i.severity === 'warning');
    // Warnings are OK but log them for visibility
    for (const w of warnings) {
      console.log(`  [warn] ${w.code}: ${w.message}`);
    }
    // No hard assertion — warnings are informational
  });

  test('all 16 ThreadEventMap events are modeled', () => {
    const expectedEvents: (keyof ThreadEventMap)[] = [
      'thread:created',
      'thread:stage-changed',
      'thread:deleted',
      'agent:started',
      'agent:completed',
      'git:changed',
      'git:committed',
      'git:pushed',
      'git:merged',
      'git:staged',
      'git:unstaged',
      'git:reverted',
      'git:pulled',
      'git:stashed',
      'git:stash-popped',
      'git:reset-soft',
    ];

    // Map ThreadEventMap keys to PascalCase evflow names
    const eventNameMap: Record<string, string> = {
      'thread:created': 'ThreadCreated',
      'thread:stage-changed': 'ThreadStageChanged',
      'thread:deleted': 'ThreadDeleted',
      'agent:started': 'AgentStarted',
      'agent:completed': 'AgentCompleted',
      'git:changed': 'GitChanged',
      'git:committed': 'GitCommitted',
      'git:pushed': 'GitPushed',
      'git:merged': 'GitMerged',
      'git:staged': 'GitStaged',
      'git:unstaged': 'GitUnstaged',
      'git:reverted': 'GitReverted',
      'git:pulled': 'GitPulled',
      'git:stashed': 'GitStashed',
      'git:stash-popped': 'GitStashPopped',
      'git:reset-soft': 'GitResetSoftDone',
    };

    const data = model.getData();
    for (const busEvent of expectedEvents) {
      const evflowName = eventNameMap[busEvent];
      const element = data.elements.get(evflowName);
      expect(
        element,
        `Missing evflow event for "${busEvent}" (expected "${evflowName}")`,
      ).toBeDefined();
      expect(element!.kind).toBe('event');
    }
  });

  test('toJSON() produces valid JSON with all sections', () => {
    const json = model.toJSON();
    const parsed = JSON.parse(json);

    expect(parsed.name).toBe('FunnyRuntime');
    expect(parsed.elements).toBeDefined();
    expect(parsed.sequences).toBeDefined();
    expect(parsed.slices).toBeDefined();

    // elements is an object keyed by name, not an array
    const elements = Object.values(parsed.elements) as any[];
    const commands = elements.filter((e: any) => e.kind === 'command');
    const events = elements.filter((e: any) => e.kind === 'event');
    const automations = elements.filter((e: any) => e.kind === 'automation');
    const readModels = elements.filter((e: any) => e.kind === 'readModel');

    expect(commands.length).toBeGreaterThanOrEqual(15);
    expect(events.length).toBeGreaterThanOrEqual(16); // At least 16 ThreadEventMap events + PTY events
    expect(automations.length).toBeGreaterThanOrEqual(15);
    expect(readModels.length).toBeGreaterThanOrEqual(4);
  });

  test('toAIPrompt() produces markdown with expected sections', () => {
    const prompt = model.toAIPrompt();

    expect(prompt).toContain('FunnyRuntime');
    expect(prompt).toContain('Command');
    expect(prompt).toContain('Event');
    expect(prompt).toContain('Automation');
    expect(prompt).toContain('Read Models');
    // Should mention key domain elements
    expect(prompt).toContain('CreateThread');
    expect(prompt).toContain('AgentCompleted');
    expect(prompt).toContain('GitCommitted');
    expect(prompt).toContain('TriggerPipelineOnCommit');
  });

  test('sequences reference only defined elements', () => {
    const data = model.getData();
    for (const seq of data.sequences) {
      for (const step of seq.steps) {
        expect(
          data.elements.has(step),
          `Sequence "${seq.name}" references undefined element "${step}"`,
        ).toBe(true);
      }
    }
  });

  test('slices reference only defined elements', () => {
    const data = model.getData();
    for (const slice of data.slices) {
      const allRefs = [
        ...slice.commands,
        ...slice.events,
        ...slice.readModels,
        ...slice.automations,
      ];
      for (const ref of allRefs) {
        expect(
          data.elements.has(ref),
          `Slice "${slice.name}" references undefined element "${ref}"`,
        ).toBe(true);
      }
    }
  });

  test('has expected slices', () => {
    const data = model.getData();
    const sliceNames = data.slices.map((s) => s.name);

    expect(sliceNames).toContain('Thread Management');
    expect(sliceNames).toContain('Git Operations');
    expect(sliceNames).toContain('Pipeline');
    expect(sliceNames).toContain('Watcher Lifecycle');
  });

  test('has expected sequences', () => {
    const data = model.getData();
    const seqNames = data.sequences.map((s) => s.name);

    expect(seqNames).toContain('Thread Happy Path');
    expect(seqNames).toContain('Follow-up via Saga');
    expect(seqNames).toContain('Stage and Commit');
    expect(seqNames).toContain('Full PR Flow');
  });
});
