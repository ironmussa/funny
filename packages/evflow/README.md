# @funny/evflow

A TypeScript DSL for [Event Modeling](https://eventmodeling.org/) — define systems as sequences of Commands, Events, Read Models, Aggregates, Screens, External Systems, Automations, Sagas, and Slices using a fluent API and tagged template literals.

The killer feature: `toAIPrompt()` generates a structured specification that an AI can use to implement the full system.

## Quick Start

```typescript
import { EventModel } from '@funny/evflow';

const system = new EventModel('Shopping Cart');
const { flow } = system;

// Commands (user intentions)
const AddItem = system.command('AddItemToCart', {
  actor: 'Customer',
  fields: { cart_id: 'string', product_id: 'string', quantity: 'number' },
});

const Checkout = system.command('Checkout', {
  actor: 'Customer',
  fields: { cart_id: 'string', payment_method: 'string' },
});

// Events (immutable facts)
const ItemAdded = system.event('ItemAddedToCart', {
  fields: { cart_id: 'string', product_id: 'string', price: 'decimal', added_at: 'datetime' },
});

const OrderPlaced = system.event('OrderPlaced', {
  fields: { order_id: 'string', cart_id: 'string', total: 'decimal' },
});

// Aggregate (decision boundary with invariants)
system.aggregate('Cart', {
  handles: [AddItem, Checkout],
  emits: [ItemAdded, OrderPlaced],
  invariants: ['Cannot add items to a checked-out cart', 'Cannot checkout an empty cart'],
});

// Read model (projection from events)
system.readModel('CartView', {
  from: [ItemAdded],
  fields: { cart_id: 'string', items: 'CartItem[]', subtotal: 'decimal' },
});

// Screen (UI that displays read models and triggers commands)
system.screen('ShoppingCartPage', {
  displays: ['CartView'],
  triggers: [AddItem, Checkout],
});

// External system (third-party integration)
system.external('PaymentGateway', {
  receives: [Checkout],
  emits: [OrderPlaced],
});

// Automation (reactive: event triggers command)
system.automation('SendConfirmationEmail', {
  on: 'OrderPlaced',
  triggers: 'SendEmail',
});

// Saga (process manager with correlation)
system.saga('OrderFulfillment', {
  on: [OrderPlaced],
  correlationKey: 'order_id',
  when: 'payment confirmed and inventory reserved',
  triggers: 'ShipOrder',
});

// Sequences (temporal flows) using tagged template literals
system.sequence('Add to Cart', flow`${AddItem} -> ${ItemAdded}`);
system.sequence('Checkout Flow', flow`${Checkout} -> ${OrderPlaced}`);

// Or with plain strings
system.sequence('Add to Cart', 'AddItemToCart -> ItemAddedToCart');

// Slices (vertical feature cuts)
system.slice('Shopping', {
  ui: 'ShoppingCartPage',
  commands: [AddItem, Checkout],
  events: [ItemAdded, OrderPlaced],
  readModels: ['CartView'],
  aggregates: ['Cart'],
  screens: ['ShoppingCartPage'],
  externals: ['PaymentGateway'],
});

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

evflow models systems using the building blocks from [Event Modeling](https://eventmodeling.org/):

| Concept             | What it represents                                         | DSL method            |
| ------------------- | ---------------------------------------------------------- | --------------------- |
| **Command**         | A user intention / action                                  | `system.command()`    |
| **Event**           | An immutable fact that happened                            | `system.event()`      |
| **Read Model**      | A projection built from events                             | `system.readModel()`  |
| **Automation**      | A reaction: event triggers command                         | `system.automation()` |
| **Aggregate**       | Decision boundary that validates commands and emits events | `system.aggregate()`  |
| **Screen**          | UI view that displays read models and triggers commands    | `system.screen()`     |
| **External System** | Third-party service at the system boundary                 | `system.external()`   |
| **Saga**            | Process manager correlating events across time             | `system.saga()`       |
| **Sequence**        | A temporal flow showing order of operations                | `system.sequence()`   |
| **Slice**           | A vertical cut through the system (feature)                | `system.slice()`      |

### How they connect

```
┌─────────┐     ┌───────────┐     ┌─────────┐     ┌────────────┐     ┌─────────┐
│ Screen   │────▶│  Command  │────▶│Aggregate│────▶│   Event    │────▶│Read     │
│          │     │           │     │         │     │            │     │Model    │
│ displays │     │ user      │     │ decides │     │ immutable  │     │         │
│ triggers │     │ intention │     │ emits   │     │ fact       │     │ from    │
└─────────┘     └───────────┘     └─────────┘     └────────────┘     └─────────┘
                      ▲                                 │
                      │                                 ▼
                ┌───────────┐                    ┌────────────┐
                │Automation │◀───────────────────│   Event    │
                │           │                    │            │
                │ triggers  │                    └────────────┘
                │ command   │                          │
                └───────────┘                          ▼
                      ▲                          ┌────────────┐
                      │                          │   Saga     │
                ┌───────────┐                    │            │
                │ External  │                    │ correlates │
                │ System    │                    │ triggers   │
                │           │                    └────────────┘
                │ receives  │
                │ emits     │
                └───────────┘
```

## Element Details

### Commands

Commands represent user intentions. They carry the data needed to perform an action.

```typescript
const AddItem = system.command('AddItemToCart', {
  actor: 'Customer', // who initiates this
  fields: { cart_id: 'string', product_id: 'string', quantity: 'number' },
  description: 'Add a product to the shopping cart',
  version: 1, // optional schema version
});
```

### Events

Events are immutable facts that happened. They're the source of truth.

```typescript
const ItemAdded = system.event('ItemAddedToCart', {
  fields: { cart_id: 'string', product_id: 'string', price: 'decimal' },
  description: 'An item was added to the cart',
  version: 1, // optional schema version
});
```

### Read Models

Read models are projections built from events. They represent the current state for a specific view.

```typescript
system.readModel('CartView', {
  from: [ItemAdded, 'ItemRemovedFromCart'], // accepts ElementRefs or strings
  fields: { cart_id: 'string', items: 'CartItem[]', subtotal: 'decimal' },
});
```

### Aggregates

Aggregates are the decision boundary between commands and events. They validate commands against business rules (invariants) and decide whether to accept or reject.

```typescript
system.aggregate('Cart', {
  handles: [AddItem, RemoveItem, Checkout], // commands it processes
  emits: [ItemAdded, ItemRemoved, OrderPlaced], // events it produces
  invariants: [
    'Cannot add items to a checked-out cart',
    'Cannot checkout an empty cart',
    'Quantity must be positive',
  ],
});
```

### Screens

Screens represent UI views. They display read models and allow users to trigger commands.

```typescript
system.screen('ShoppingCartPage', {
  displays: ['CartView', 'RecommendationsView'], // read models shown
  triggers: [AddItem, RemoveItem, Checkout], // commands the user can fire
});
```

### External Systems

External systems are third-party services at the system boundary. They receive commands and/or emit events.

```typescript
system.external('PaymentGateway', {
  receives: [ProcessPayment], // commands sent to it
  emits: [PaymentConfirmed], // events it produces
});

// External that only receives (fire-and-forget)
system.external('EmailService', {
  receives: [SendEmail],
});

// External that only emits (webhook/integration)
system.external('StripeWebhook', {
  emits: [PaymentReceived],
});
```

### Automations

Automations are reactive handlers: when an event occurs, trigger a command.

```typescript
system.automation('RefreshInventoryOnOrder', {
  on: 'OrderPlaced', // the event that triggers it
  triggers: 'UpdateInventory', // the command it fires
});
```

### Sagas

Sagas (process managers) coordinate long-running processes across multiple events. They correlate events by a key and trigger commands conditionally.

```typescript
system.saga('OrderFulfillment', {
  on: [OrderPlaced, PaymentConfirmed], // events it listens to
  correlationKey: 'order_id', // how to correlate events
  when: 'payment confirmed and inventory reserved', // condition
  triggers: [ShipOrder, SendConfirmation], // commands it fires
});
```

### Sequences

Sequences define temporal flows — the order in which things happen. Use tagged template literals for type-safe references:

```typescript
const { flow } = system;

// Tagged template literal (type-safe, refactoring-friendly)
system.sequence('Checkout Flow', flow`${AddItem} -> ${ItemAdded} -> ${Checkout} -> ${OrderPlaced}`);

// Plain string (simpler, but no compile-time checks)
system.sequence('Checkout Flow', 'AddItemToCart -> ItemAddedToCart -> Checkout -> OrderPlaced');
```

### Slices

Slices are vertical cuts through the system — each slice groups all the elements that belong to a single feature.

```typescript
system.slice('Shopping Cart', {
  ui: 'ShoppingCartPage',
  commands: [AddItem, RemoveItem, Checkout],
  events: [ItemAdded, ItemRemoved, OrderPlaced],
  readModels: ['CartView'],
  automations: ['RefreshInventoryOnOrder'],
  aggregates: ['Cart'],
  screens: ['ShoppingCartPage'],
  externals: ['PaymentGateway'],
  sagas: ['OrderFulfillment'],
});
```

## Output Formats

| Method               | Output             | Purpose                                            |
| -------------------- | ------------------ | -------------------------------------------------- |
| `toJSON()`           | JSON               | Serialization, tooling integration                 |
| `toAIPrompt()`       | Markdown           | Structured spec for AI code generation             |
| `toMermaid()`        | Mermaid text       | Flowchart or sequence diagrams                     |
| `toReactFlowGraph()` | `{ nodes, edges }` | Interactive graph visualization                    |
| `validate()`         | `Result<issues>`   | Consistency checks (orphans, unknown refs, cycles) |

### Mermaid Diagrams

Generate Mermaid diagrams for documentation, GitHub READMEs, or any Mermaid-compatible viewer:

```typescript
// Flowchart (default) — shows element relationships grouped by slice
console.log(system.toMermaid());

// Vertical layout
console.log(system.toMermaid({ direction: 'TB' }));

// Filter to a specific slice
console.log(system.toMermaid({ slice: 'Shopping Cart' }));

// Sequence diagrams — one per defined sequence
console.log(system.toMermaid({ mode: 'sequence' }));

// Filter to a specific sequence
console.log(system.toMermaid({ mode: 'sequence', sequence: 'Checkout Flow' }));
```

### React Flow Graph

Generate React Flow-compatible nodes and edges for interactive visualization:

```typescript
import { generateReactFlowGraph, EVFLOW_COLORS, EVFLOW_ICONS } from '@funny/evflow';

// From an EventModel instance
const graph = system.toReactFlowGraph();

// Or from raw EventModelData
const graph = generateReactFlowGraph(model.getData(), {
  slice: 'Shopping Cart', // filter to slice
  groupBySlice: true, // create group nodes for slices
  direction: 'LR', // layout direction
});

// graph.nodes — React Flow nodes with kind, description, fields, slices
// graph.edges — React Flow edges with labels, colors, animation for events
```

### Interactive Viewer

A standalone React Flow viewer app is included at `packages/evflow/viewer/`:

```bash
# Start the viewer dev server
cd packages/evflow && bun run viewer

# Or build it
cd packages/evflow && bun run viewer:build
```

The viewer accepts a JSON file (generated by `model.toJSON()`) and provides:

- Interactive graph with Dagre auto-layout
- Sidebar with search, kind filters, and slice filters
- Element details panel (fields, invariants, description)
- Elements list view grouped by kind
- Sequences view showing temporal flows

### Validation Checks

`validate()` returns a `Result<ValidationIssue[], never>` with:

- Unknown references in read model `from`, automation `on`/`triggers`
- Read models sourcing from non-event elements
- Invalid sequence transitions (e.g. event → event without a command)
- Orphan elements not used in any sequence
- Dead events not consumed by any read model, automation, or saga
- Automation cycles (A triggers B triggers A)
- Aggregate reference validation (handles → commands, emits → events)
- Screen reference validation (displays → read models, triggers → commands)
- External system reference validation
- Saga reference validation (on → events, triggers → commands)
- Slice reference validation (all referenced elements must exist)

## VS Code Plugin

evflow includes a TypeScript Language Service Plugin that provides real-time feedback as you type:

- Red squiggly lines on invalid element references
- Autocompletion of element names inside strings
- Type-aware filtering (only events for `from`/`on`, only commands for `triggers`)
- Support for all element types: commands, events, read models, automations, aggregates, screens, externals, sagas

See [docs/plugin.md](docs/plugin.md) for setup instructions.

## License

Part of the funny monorepo.
