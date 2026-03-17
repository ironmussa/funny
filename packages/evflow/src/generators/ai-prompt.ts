import type {
  EventModelData,
  CommandDef,
  EventDef,
  ReadModelDef,
  AutomationDef,
  ElementDef,
} from '../types.js';

/**
 * Generate a structured AI prompt from an EventModel.
 *
 * The prompt is structured markdown that describes the full system:
 * commands, events, read models, automations, sequences, and
 * implementation guidance — ready for an AI to implement.
 */
export function generateAIPrompt(model: EventModelData): string {
  const lines: string[] = [];

  lines.push(`# Event Model: ${model.name}`);
  lines.push('');
  lines.push('This document describes the complete event model for the system.');
  lines.push('Use this as the specification to implement the system.');
  lines.push('');

  const commands = byKind<CommandDef>(model, 'command');
  const events = byKind<EventDef>(model, 'event');
  const readModels = byKind<ReadModelDef>(model, 'readModel');
  const automations = byKind<AutomationDef>(model, 'automation');

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
      lines.push('- **Fields:**');
      for (const [field, type] of Object.entries(evt.fields)) {
        lines.push(`  - \`${field}\`: ${type}`);
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
  lines.push('');

  return lines.join('\n');
}

function byKind<T extends ElementDef>(model: EventModelData, kind: string): T[] {
  return [...model.elements.values()].filter((e) => e.kind === kind) as T[];
}
