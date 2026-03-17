# Sequences & Flows

Sequences define the **temporal ordering** of your system — how commands produce events, how events trigger automations, and how the system behaves over time.

## Two Ways to Define Sequences

### 1. Tagged Template Literals (recommended)

```typescript
const system = new EventModel('Shop');
const AddItem = system.command('AddItem', { fields: { id: 'string' } });
const ItemAdded = system.event('ItemAdded', { fields: { id: 'string' } });
const StartCheckout = system.command('StartCheckout', { fields: {} });
const CheckoutStarted = system.event('CheckoutStarted', { fields: {} });

const { flow } = system;

system.sequence('Happy Path', flow`
  ${AddItem} -> ${ItemAdded} -> ${StartCheckout} -> ${CheckoutStarted}
`);
```

**Why this is the recommended approach:**

- **Immediate validation** — if you reference a variable that doesn't exist, JavaScript throws a `ReferenceError` before anything runs
- **Refactoring support** — rename a variable and all references update
- **Go-to-definition** — Ctrl+click on a variable goes to its declaration

```typescript
// This fails IMMEDIATELY with ReferenceError:
system.sequence('Bug', flow`${AddItem} -> ${NonExistentEvent}`);
//                                         ^^^^^^^^^^^^^^^^
// ReferenceError: NonExistentEvent is not defined
```

### 2. String Notation

```typescript
system.sequence('Happy Path', 'AddItem -> ItemAdded -> StartCheckout -> CheckoutStarted');
```

**When to use strings:**

- Quick prototyping
- When reading sequences from external files or configs
- When the model is defined dynamically

**Trade-off:** typos in element names are only caught when you call `system.validate()`, not at definition time.

```typescript
// This does NOT fail immediately — typo is silent:
system.sequence('Bug', 'AddItem -> ItmeAdded');
//                                  ^^^^^^^^ typo, caught by validate()
```

## Multiline Sequences

Both approaches support multiline for readability:

```typescript
// Tagged template — naturally multiline
system.sequence('Full Checkout', flow`
  ${AddItem}
  -> ${ItemAdded}
  -> ${StartCheckout}
  -> ${CheckoutStarted}
  -> ${ProcessPayment}
  -> ${PaymentSucceeded}
  -> ${OrderConfirmed}
`);

// String — also works multiline
system.sequence('Full Checkout', `
  AddItem -> ItemAdded
  -> StartCheckout -> CheckoutStarted
  -> ProcessPayment -> PaymentSucceeded
  -> OrderConfirmed
`);
```

## Multiple Sequences (Happy Path + Sad Paths)

Define multiple sequences to cover different scenarios:

```typescript
system.sequence('Happy Path', flow`
  ${PlaceOrder} -> ${OrderPlaced} -> ${ProcessPayment} -> ${PaymentSucceeded} -> ${OrderConfirmed}
`);

system.sequence('Payment Fails', flow`
  ${PlaceOrder} -> ${OrderPlaced} -> ${ProcessPayment} -> ${PaymentFailed} -> ${NotifyCustomer}
`);

system.sequence('Order Cancelled', flow`
  ${CancelOrder} -> ${OrderCancelled} -> ${RefundPayment} -> ${PaymentRefunded}
`);
```

## Sequences with Automations

Automations appear in sequences as steps — they show where the system reacts automatically:

```typescript
const TriggerPayment = system.automation('TriggerPayment', {
  on: 'OrderPlaced',
  triggers: 'ProcessPayment',
});

system.sequence('With Automation', flow`
  ${PlaceOrder} -> ${OrderPlaced} -> ${TriggerPayment} -> ${ProcessPayment} -> ${PaymentSucceeded}
`);
```

This makes it clear that `ProcessPayment` is not triggered by a user — it's an automatic reaction to `OrderPlaced`.

## How flow\`\` Works Internally

The `flow` tag is a [tagged template literal](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Template_literals#tagged_templates) — a function that intercepts the template before it becomes a string.

When you write:
```typescript
flow`${AddItem} -> ${ItemAdded} -> ${CheckoutStarted}`
```

JavaScript calls `flow` with:
```typescript
flow(
  ['', ' -> ', ' -> ', ''],           // static string parts
  AddItem, ItemAdded, CheckoutStarted  // interpolated values (ElementRef objects)
)
```

The function:
1. Validates that all static parts between elements are `->` arrows
2. Validates that all interpolated values are `ElementRef` objects
3. Returns a `SequenceStep[]` array

This means:
- **Non-ElementRef values are rejected** — `flow\`${"hello"} -> ${42}\`` throws
- **Missing arrows are rejected** — `flow\`${A} then ${B}\`` throws
- **Undefined variables are rejected** — JavaScript itself throws `ReferenceError`

## Destructuring flow

`flow` is an arrow function property on the `EventModel` instance, so you can destructure it:

```typescript
const system = new EventModel('Shop');
const { flow } = system;  // works because flow is an arrow function

system.sequence('Flow', flow`${A} -> ${B}`);
```
