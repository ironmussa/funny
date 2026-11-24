import type { EventModelData, ElementDef, ElementKind } from '../types.js';

/**
 * Generate a structured AI prompt from an EventModel.
 *
 * The prompt is structured markdown that describes the full system:
 * commands, events, read models, automations, aggregates, screens,
 * external systems, sagas, sequences, slices, and contexts —
 * ready for an AI to implement.
 */
export function generateAIPrompt(model: EventModelData): string {
  const lines: string[] = [];

  lines.push(`# Event Model: ${model.name}`);
  lines.push('');
  lines.push('This document describes the complete event model for the system.');
  lines.push('Use this as the specification to implement the system.');
  lines.push('');

  const commands = byKind(model, 'command');
  const events = byKind(model, 'event');
  const readModels = byKind(model, 'readModel');
  const automations = byKind(model, 'automation');
  const aggregates = byKind(model, 'aggregate');
  const screens = byKind(model, 'screen');
  const externals = byKind(model, 'external');
  const sagas = byKind(model, 'saga');

  // Commands
  if (commands.length > 0) {
    lines.push('## Commands');
    lines.push('');
    lines.push('Commands represent user intentions. Each command is triggered by an actor.');
    lines.push('');
    for (const cmd of commands) {
      lines.push(`### ${cmd.name}`);
      if (cmd.actor) lines.push(`- **Actor:** ${cmd.actor}`);
      if (cmd.description) lines.push(`- **Description:** ${cmd.description}`);
      if (cmd.version) lines.push(`- **Version:** ${cmd.version}`);
      lines.push('- **Fields:**');
      for (const [field, type] of Object.entries(cmd.fields)) {
        lines.push(`  - \`${field}\`: ${type}`);
      }
      lines.push('');
    }
  }

  // Events
  if (events.length > 0) {
    lines.push('## Events');
    lines.push('');
    lines.push('Events are immutable facts that have happened. They are the source of truth.');
    lines.push('');
    for (const evt of events) {
      lines.push(`### ${evt.name}`);
      if (evt.description) lines.push(`- **Description:** ${evt.description}`);
      if (evt.version) lines.push(`- **Version:** ${evt.version}`);
      lines.push('- **Fields:**');
      for (const [field, type] of Object.entries(evt.fields)) {
        lines.push(`  - \`${field}\`: ${type}`);
      }
      lines.push('');
    }
  }

  // Aggregates
  if (aggregates.length > 0) {
    lines.push('## Aggregates');
    lines.push('');
    lines.push(
      'Aggregates validate commands and decide whether to accept or reject them. They are the decision boundary between commands and events.',
    );
    lines.push('');
    for (const agg of aggregates) {
      lines.push(`### ${agg.name}`);
      if (agg.description) lines.push(`- **Description:** ${agg.description}`);
      lines.push(`- **Handles:** ${agg.handles.join(', ')}`);
      lines.push(`- **Emits:** ${agg.emits.join(', ')}`);
      if (agg.invariants.length > 0) {
        lines.push('- **Invariants:**');
        for (const inv of agg.invariants) {
          lines.push(`  - ${inv}`);
        }
      }
      lines.push('');
    }
  }

  // Read Models
  if (readModels.length > 0) {
    lines.push('## Read Models');
    lines.push('');
    lines.push('Read models are projections built from events. They serve queries.');
    lines.push('');
    for (const rm of readModels) {
      lines.push(`### ${rm.name}`);
      if (rm.description) lines.push(`- **Description:** ${rm.description}`);
      lines.push(`- **Projects from:** ${rm.from.join(', ')}`);
      lines.push('- **Fields:**');
      for (const [field, type] of Object.entries(rm.fields)) {
        lines.push(`  - \`${field}\`: ${type}`);
      }
      lines.push('');
    }
  }

  // Screens
  if (screens.length > 0) {
    lines.push('## Screens');
    lines.push('');
    lines.push(
      'Screens represent UI views. They display read models and allow users to trigger commands.',
    );
    lines.push('');
    for (const scr of screens) {
      lines.push(`### ${scr.name}`);
      if (scr.description) lines.push(`- **Description:** ${scr.description}`);
      lines.push(`- **Displays:** ${scr.displays.join(', ')}`);
      lines.push(`- **Triggers:** ${scr.triggers.join(', ')}`);
      lines.push('');
    }
  }

  // Automations
  if (automations.length > 0) {
    lines.push('## Automations');
    lines.push('');
    lines.push('Automations react to events and trigger commands automatically.');
    lines.push('');
    for (const auto of automations) {
      lines.push(`### ${auto.name}`);
      if (auto.description) lines.push(`- **Description:** ${auto.description}`);
      lines.push(`- **Triggered by:** ${auto.on}`);
      const triggers = Array.isArray(auto.triggers) ? auto.triggers.join(', ') : auto.triggers;
      lines.push(`- **Triggers:** ${triggers}`);
      lines.push('');
    }
  }

  // Sagas
  if (sagas.length > 0) {
    lines.push('## Sagas (Process Managers)');
    lines.push('');
    lines.push(
      'Sagas coordinate across multiple events. They accumulate state using a correlation key and trigger commands when a condition is met.',
    );
    lines.push('');
    for (const saga of sagas) {
      lines.push(`### ${saga.name}`);
      if (saga.description) lines.push(`- **Description:** ${saga.description}`);
      lines.push(`- **Listens to:** ${saga.on.join(', ')}`);
      lines.push(`- **Correlation key:** ${saga.correlationKey}`);
      lines.push(`- **Condition:** ${saga.when}`);
      const triggers = Array.isArray(saga.triggers) ? saga.triggers.join(', ') : saga.triggers;
      lines.push(`- **Triggers:** ${triggers}`);
      lines.push('');
    }
  }

  // External Systems
  if (externals.length > 0) {
    lines.push('## External Systems');
    lines.push('');
    lines.push('External systems are third-party services that interact with the system boundary.');
    lines.push('');
    for (const ext of externals) {
      lines.push(`### ${ext.name}`);
      if (ext.description) lines.push(`- **Description:** ${ext.description}`);
      if (ext.receives.length > 0) lines.push(`- **Receives:** ${ext.receives.join(', ')}`);
      if (ext.emits.length > 0) lines.push(`- **Emits:** ${ext.emits.join(', ')}`);
      lines.push('');
    }
  }

  // Sequences
  if (model.sequences.length > 0) {
    lines.push('## Sequences (Temporal Flows)');
    lines.push('');
    lines.push('Sequences show the temporal ordering of the system behavior.');
    lines.push('');
    for (const seq of model.sequences) {
      lines.push(`### ${seq.name}`);
      lines.push('');
      lines.push('```');
      lines.push(seq.steps.join(' -> '));
      lines.push('```');
      lines.push('');
      for (let i = 0; i < seq.steps.length; i++) {
        const step = seq.steps[i];
        const el = model.elements.get(step);
        const kind = el ? el.kind : 'unknown';
        lines.push(`${i + 1}. **${step}** (${kind})`);
      }
      lines.push('');
    }
  }

  // Slices
  if (model.slices.length > 0) {
    lines.push('## Slices (Vertical Cuts)');
    lines.push('');
    for (const slice of model.slices) {
      lines.push(`### ${slice.name}`);
      if (slice.ui) lines.push(`- **UI:** ${slice.ui}`);
      if (slice.commands.length > 0) lines.push(`- **Commands:** ${slice.commands.join(', ')}`);
      if (slice.events.length > 0) lines.push(`- **Events:** ${slice.events.join(', ')}`);
      if (slice.readModels.length > 0)
        lines.push(`- **Read Models:** ${slice.readModels.join(', ')}`);
      if (slice.automations.length > 0)
        lines.push(`- **Automations:** ${slice.automations.join(', ')}`);
      if (slice.aggregates.length > 0)
        lines.push(`- **Aggregates:** ${slice.aggregates.join(', ')}`);
      if (slice.screens.length > 0) lines.push(`- **Screens:** ${slice.screens.join(', ')}`);
      if (slice.externals.length > 0)
        lines.push(`- **External Systems:** ${slice.externals.join(', ')}`);
      if (slice.sagas.length > 0) lines.push(`- **Sagas:** ${slice.sagas.join(', ')}`);
      lines.push('');
    }
  }

  // Bounded Contexts
  if (model.contexts.length > 0) {
    lines.push('## Bounded Contexts');
    lines.push('');
    lines.push('Bounded contexts group related elements into cohesive modules.');
    lines.push('');
    for (const ctx of model.contexts) {
      lines.push(`### ${ctx.name}`);
      lines.push(`- **Elements:** ${ctx.elements.join(', ')}`);
      lines.push('');
    }
  }

  // Implementation guidance
  lines.push('## Implementation Guidance');
  lines.push('');
  lines.push(
    '1. **Commands** should be implemented as request handlers that validate input and produce events.',
  );
  lines.push('2. **Events** should be stored in an append-only event store. They are immutable.');
  lines.push(
    '3. **Read Models** should be built by subscribing to the relevant events and maintaining a projected view.',
  );
  lines.push('4. **Automations** should be implemented as event handlers that dispatch commands.');
  lines.push(
    '5. **Sequences** define the expected temporal ordering — use them to write integration tests.',
  );
  lines.push(
    '6. **Aggregates** enforce business rules (invariants) before accepting commands. Implement as domain entities with guard methods.',
  );
  lines.push(
    '7. **Screens** map to UI components/pages. Each screen displays specific read models and exposes specific commands.',
  );
  lines.push(
    '8. **External Systems** require integration adapters (API clients, webhooks). Commands they receive are outbound calls; events they emit are inbound webhooks.',
  );
  lines.push(
    '9. **Sagas** are stateful process managers. Implement them with persistent state keyed by the correlation key. When all conditions are met, dispatch the triggered command.',
  );
  lines.push('');

  return lines.join('\n');
}

function byKind<K extends ElementKind>(
  model: EventModelData,
  kind: K,
): Extract<ElementDef, { kind: K }>[] {
  return [...model.elements.values()].filter(
    (e): e is Extract<ElementDef, { kind: K }> => e.kind === kind,
  );
}
