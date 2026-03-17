# @funny/evflow

A TypeScript DSL for [Event Modeling](https://eventmodeling.org/) — define systems as sequences of Commands, Events, Read Models, and Automations using a fluent API and tagged template literals.

The killer feature: `toAIPrompt()` generates a structured specification that an AI can use to implement the full system.

## Quick Start

```typescript
import { EventModel } from '@funny/evflow';

const system = new EventModel('Shopping Cart');

// Define commands (user intentions)
const AddItem = system.command('AddItemToCart', {
  actor: 'Customer',
  fields: { cart_id: 'string', product_id: 'string', quantity: 'number' },
});

// Define events (immutable facts)
const ItemAdded = system.event('ItemAddedToCart', {
  fields: { cart_id: 'string', product_id: 'string', price: 'decimal', added_at: 'datetime' },
});

// Define read models (projections from events)
system.readModel('CartView', {
  from: ['ItemAddedToCart'],
  fields: { cart_id: 'string', items: 'CartItem[]', subtotal: 'decimal' },
});

// Define sequences using tagged template literals
const { flow } = system;
system.sequence('Add to Cart', flow`${AddItem} -> ${ItemAdded}`);

// Or with plain strings
system.sequence('Add to Cart', 'AddItemToCart -> ItemAddedToCart');

// Validate, export JSON, or generate an AI prompt
system.validate();
console.log(system.toJSON());
console.log(system.toAIPrompt());
```

## Installation

`evflow` is part of the funny monorepo. It's available as `@funny/evflow` via Bun workspaces.

```bash
bun install
```

## Documentation

- [DSL API Reference](docs/api.md) — All methods, types, and options
- [Sequences & Flows](docs/sequences.md) — Tagged template literals and string sequences
- [VS Code Plugin](docs/plugin.md) — Real-time validation and autocompletion
- [Examples](docs/examples.md) — Full event models for common domains

## Core Concepts

evflow models systems using four building blocks from [Event Modeling](https://eventmodeling.org/):

| Concept | What it represents | DSL method |
|---------|-------------------|------------|
| **Command** | A user intention / action | `system.command()` |
| **Event** | An immutable fact that happened | `system.event()` |
| **Read Model** | A projection built from events | `system.readModel()` |
| **Automation** | A reaction: event triggers command | `system.automation()` |

These are connected through **sequences** (temporal flows) and organized into **slices** (vertical cuts of functionality).

## Output Formats

| Method | Output | Purpose |
|--------|--------|---------|
| `toJSON()` | JSON | Serialization, tooling integration |
| `toAIPrompt()` | Markdown | Structured spec for AI code generation |
| `validate()` | `Result<issues>` | Consistency checks (orphans, unknown refs) |

## VS Code Plugin

evflow includes a TypeScript Language Service Plugin that provides real-time feedback as you type:

- Red squiggly lines on invalid element references
- Autocompletion of element names inside strings
- Type-aware filtering (only events for `from`/`on`, only commands for `triggers`)

See [docs/plugin.md](docs/plugin.md) for setup instructions.

## License

Part of the funny monorepo.
