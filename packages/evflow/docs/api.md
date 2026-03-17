# API Reference

## EventModel

The main class. Create one instance per system you're modeling.

```typescript
import { EventModel } from '@funny/evflow';

const system = new EventModel('My System');
```

---

### `system.command(name, options): ElementRef`

Register a command (user intention).

```typescript
const PlaceOrder = system.command('PlaceOrder', {
  actor: 'Customer',                    // optional — who triggers this
  description: 'Customer places order', // optional
  fields: {
    order_id: 'uuid',
    items: 'OrderItem[]',
    shipping_address: 'Address',
  },
});
```

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | yes | Unique name (PascalCase) |
| `options.fields` | `FieldMap` | yes | Data payload |
| `options.actor` | `string` | no | Who triggers this command |
| `options.description` | `string` | no | Human-readable description |

**Returns:** `ElementRef` — a lightweight handle you can use in `flow` templates and slices.

---

### `system.event(name, options): ElementRef`

Register an event (immutable fact that happened).

```typescript
const OrderPlaced = system.event('OrderPlaced', {
  description: 'An order was successfully placed',
  fields: {
    order_id: 'uuid',
    items: 'OrderItem[]',
    total: 'decimal',
    placed_at: 'datetime',
  },
});
```

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | yes | Unique name (PascalCase, past tense) |
| `options.fields` | `FieldMap` | yes | Event data payload |
| `options.description` | `string` | no | Human-readable description |

---

### `system.readModel(name, options): ElementRef`

Register a read model (projection built from events).

```typescript
const OrderList = system.readModel('OrderList', {
  from: ['OrderPlaced', 'OrderShipped', 'OrderCancelled'],
  description: 'List of orders for the customer dashboard',
  fields: {
    orders: 'OrderSummary[]',
    total_count: 'number',
  },
});
```

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | yes | Unique name |
| `options.from` | `string[]` | yes | Event names this model projects from |
| `options.fields` | `FieldMap` | yes | Shape of the projected view |
| `options.description` | `string` | no | Human-readable description |

---

### `system.automation(name, options): ElementRef`

Register an automation (event-driven reaction).

```typescript
const SendConfirmation = system.automation('SendConfirmation', {
  on: 'OrderPlaced',
  triggers: 'SendEmail',
  description: 'Send confirmation email when order is placed',
});
```

An automation can trigger multiple commands:

```typescript
system.automation('PostOrderProcessing', {
  on: 'OrderPlaced',
  triggers: ['SendEmail', 'ReserveInventory', 'ChargePayment'],
});
```

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | yes | Unique name |
| `options.on` | `string` | yes | Event name that triggers this |
| `options.triggers` | `string \| string[]` | yes | Command(s) to execute |
| `options.description` | `string` | no | Human-readable description |

---

### `system.sequence(name, steps)`

Register a named temporal sequence. See [sequences.md](sequences.md) for details.

```typescript
// With tagged template literal
const { flow } = system;
system.sequence('Happy Path', flow`${PlaceOrder} -> ${OrderPlaced} -> ${SendConfirmation}`);

// With plain string
system.sequence('Happy Path', 'PlaceOrder -> OrderPlaced -> SendConfirmation');
```

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | yes | Descriptive name for this flow |
| `steps` | `SequenceStep[] \| string` | yes | Flow from `flow` tag or arrow-separated string |

---

### `system.slice(name, options)`

Register a vertical slice (UI + commands + events + read models + automations).

```typescript
system.slice('Place Order', {
  ui: 'CheckoutPage',
  commands: [PlaceOrder],
  events: [OrderPlaced],
  readModels: [OrderList],
  automations: [SendConfirmation],
});
```

All arrays accept both `ElementRef` objects and plain strings:

```typescript
system.slice('Place Order', {
  ui: 'CheckoutPage',
  commands: ['PlaceOrder'],    // string refs work too
  events: [OrderPlaced],       // or ElementRef objects
});
```

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | yes | Slice name |
| `options.ui` | `string` | no | UI screen/page name |
| `options.commands` | `Array<ElementRef \| string>` | no | Commands in this slice |
| `options.events` | `Array<ElementRef \| string>` | no | Events in this slice |
| `options.readModels` | `Array<ElementRef \| string>` | no | Read models in this slice |
| `options.automations` | `Array<ElementRef \| string>` | no | Automations in this slice |

---

### `system.validate(): Result<ValidationIssue[], ValidationIssue[]>`

Validate the model for consistency. Returns a `neverthrow` Result:

- `ok(issues)` — no errors (may contain warnings)
- `err(issues)` — contains errors

```typescript
const result = system.validate();

result.match(
  (warnings) => console.log('Valid!', warnings),
  (issues) => {
    for (const issue of issues) {
      console.error(`[${issue.code}] ${issue.message}`);
    }
  },
);
```

See [Validation Rules](#validation-rules) below.

---

### `system.toJSON(): string`

Export the model as a formatted JSON string.

```typescript
const json = system.toJSON();
// Write to file, send to API, etc.
```

---

### `system.toAIPrompt(): string`

Generate a structured Markdown prompt describing the full system. Designed to be given to an AI (Claude, GPT, etc.) to implement the system.

```typescript
const prompt = system.toAIPrompt();
// Pass to an AI model to generate the implementation
```

The prompt includes: commands with actors and fields, events with fields, read models with projections, automations with triggers, sequences with temporal flows, and implementation guidance.

---

### `system.getData(): EventModelData`

Get a snapshot of the model data for custom generators or analysis.

```typescript
const data = system.getData();
// data.elements: Map<string, ElementDef>
// data.sequences: SequenceDef[]
// data.slices: SliceDef[]
```

---

### `system.getElement(name): ElementDef | undefined`

Look up a specific element by name.

```typescript
const el = system.getElement('PlaceOrder');
if (el?.kind === 'command') {
  console.log(el.actor, el.fields);
}
```

---

## Field Types

Fields are defined as string type annotations:

| Type | Description |
|------|-------------|
| `'string'` | Text |
| `'number'` | Numeric value |
| `'boolean'` | True/false |
| `'decimal'` | Precise numeric (money, etc.) |
| `'datetime'` | Date and time |
| `'date'` | Date only |
| `'uuid'` | Unique identifier |
| `'MyType[]'` | Array of custom type |
| `'MyType'` | Custom/domain type |

```typescript
system.event('OrderPlaced', {
  fields: {
    order_id: 'uuid',
    total: 'decimal',
    items: 'OrderItem[]',    // array of custom type
    placed_at: 'datetime',
    is_gift: 'boolean',
  },
});
```

---

## Validation Rules

| Code | Severity | Description |
|------|----------|-------------|
| `READ_MODEL_UNKNOWN_SOURCE` | error | `readModel.from` references an event that doesn't exist |
| `READ_MODEL_INVALID_SOURCE` | error | `readModel.from` references something that isn't an event |
| `AUTOMATION_UNKNOWN_EVENT` | error | `automation.on` references an event that doesn't exist |
| `AUTOMATION_INVALID_EVENT` | error | `automation.on` references something that isn't an event |
| `AUTOMATION_UNKNOWN_COMMAND` | error | `automation.triggers` references a command that doesn't exist |
| `AUTOMATION_TRIGGERS_NON_COMMAND` | warning | `automation.triggers` references something that isn't a command |
| `SEQUENCE_UNKNOWN_ELEMENT` | error | A sequence step references an undefined element |
| `SLICE_UNKNOWN_ELEMENT` | error | A slice references an undefined element |
| `ORPHAN_EVENT` | warning | Event defined but never used in any sequence |
| `ORPHAN_COMMAND` | warning | Command defined but never used in any sequence |
| `DUPLICATE_SEQUENCE_NAME` | warning | Two sequences share the same name |

---

## ElementRef

Every `system.command()`, `system.event()`, etc. returns an `ElementRef`:

```typescript
interface ElementRef {
  readonly name: string;
  readonly kind: ElementKind;  // 'command' | 'event' | 'readModel' | 'automation'
  toString(): string;          // returns the name
}
```

`toString()` returns the name, which is what makes tagged template literal interpolation work — when you write `flow\`${PlaceOrder}\``, JavaScript calls `PlaceOrder.toString()` to get `"PlaceOrder"`.
