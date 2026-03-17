import { describe, test, expect } from 'bun:test';

import { EventModel } from '../event-model.js';

function buildShoppingCart(): EventModel {
  const sys = new EventModel('Shopping Cart');

  const AddItem = sys.command('AddItemToCart', {
    actor: 'Customer',
    fields: { cart_id: 'string', product_id: 'string', quantity: 'number' },
  });

  const ItemAdded = sys.event('ItemAddedToCart', {
    fields: { cart_id: 'string', product_id: 'string', price: 'decimal', added_at: 'datetime' },
  });

  const StartCheckout = sys.command('StartCheckout', {
    actor: 'Customer',
    fields: { cart_id: 'string' },
  });

  const CheckoutStarted = sys.event('CheckoutStarted', {
    fields: { order_id: 'string', cart_id: 'string' },
  });

  const ProcessPayment = sys.command('ProcessPayment', {
    actor: 'System',
    fields: { order_id: 'string', amount: 'decimal' },
  });

  const PaymentSucceeded = sys.event('PaymentSucceeded', {
    fields: { order_id: 'string', transaction_id: 'string' },
  });

  sys.readModel('CartView', {
    from: ['ItemAddedToCart'],
    fields: { cart_id: 'string', items: 'CartItem[]', subtotal: 'decimal' },
  });

  sys.readModel('OrderStatus', {
    from: ['CheckoutStarted', 'PaymentSucceeded'],
    fields: { order_id: 'string', status: 'string' },
  });

  sys.automation('TriggerPayment', {
    on: 'CheckoutStarted',
    triggers: 'ProcessPayment',
    description: 'Automatically process payment when checkout starts',
  });

  const { flow } = sys;
  sys.sequence(
    'Happy Path',
    flow`
    ${AddItem} -> ${ItemAdded} -> ${StartCheckout} -> ${CheckoutStarted} -> ${ProcessPayment} -> ${PaymentSucceeded}
  `,
  );

  sys.slice('Checkout', {
    ui: 'CheckoutPage',
    commands: [StartCheckout],
    events: [CheckoutStarted, PaymentSucceeded],
    readModels: ['OrderStatus'],
    automations: ['TriggerPayment'],
  });

  return sys;
}

describe('toJSON()', () => {
  test('produces valid JSON with all sections', () => {
    const sys = buildShoppingCart();
    const json = sys.toJSON();
    const parsed = JSON.parse(json);

    expect(parsed.name).toBe('Shopping Cart');
    expect(Object.keys(parsed.elements)).toContain('AddItemToCart');
    expect(Object.keys(parsed.elements)).toContain('ItemAddedToCart');
    expect(Object.keys(parsed.elements)).toContain('CartView');
    expect(Object.keys(parsed.elements)).toContain('TriggerPayment');
    expect(parsed.sequences).toHaveLength(1);
    expect(parsed.sequences[0].name).toBe('Happy Path');
    expect(parsed.slices).toHaveLength(1);
  });

  test('roundtrips through JSON.parse', () => {
    const sys = buildShoppingCart();
    const json = sys.toJSON();
    expect(() => JSON.parse(json)).not.toThrow();
  });

  test('elements have correct kind', () => {
    const sys = buildShoppingCart();
    const parsed = JSON.parse(sys.toJSON());
    expect(parsed.elements.AddItemToCart.kind).toBe('command');
    expect(parsed.elements.ItemAddedToCart.kind).toBe('event');
    expect(parsed.elements.CartView.kind).toBe('readModel');
    expect(parsed.elements.TriggerPayment.kind).toBe('automation');
  });
});

describe('toAIPrompt()', () => {
  test('includes system name in header', () => {
    const sys = buildShoppingCart();
    const prompt = sys.toAIPrompt();
    expect(prompt).toContain('# Event Model: Shopping Cart');
  });

  test('includes commands section with actors and fields', () => {
    const sys = buildShoppingCart();
    const prompt = sys.toAIPrompt();
    expect(prompt).toContain('## Commands');
    expect(prompt).toContain('### AddItemToCart');
    expect(prompt).toContain('**Actor:** Customer');
    expect(prompt).toContain('`cart_id`: string');
  });

  test('includes events section with fields', () => {
    const sys = buildShoppingCart();
    const prompt = sys.toAIPrompt();
    expect(prompt).toContain('## Events');
    expect(prompt).toContain('### ItemAddedToCart');
    expect(prompt).toContain('`price`: decimal');
  });

  test('includes read models with from and fields', () => {
    const sys = buildShoppingCart();
    const prompt = sys.toAIPrompt();
    expect(prompt).toContain('## Read Models');
    expect(prompt).toContain('### CartView');
    expect(prompt).toContain('**Projects from:** ItemAddedToCart');
    expect(prompt).toContain('`items`: CartItem[]');
  });

  test('includes automations with on and triggers', () => {
    const sys = buildShoppingCart();
    const prompt = sys.toAIPrompt();
    expect(prompt).toContain('## Automations');
    expect(prompt).toContain('### TriggerPayment');
    expect(prompt).toContain('**Triggered by:** CheckoutStarted');
    expect(prompt).toContain('**Triggers:** ProcessPayment');
  });

  test('includes sequences with temporal flow', () => {
    const sys = buildShoppingCart();
    const prompt = sys.toAIPrompt();
    expect(prompt).toContain('## Sequences');
    expect(prompt).toContain('### Happy Path');
    expect(prompt).toContain('AddItemToCart -> ItemAddedToCart');
  });

  test('includes slices', () => {
    const sys = buildShoppingCart();
    const prompt = sys.toAIPrompt();
    expect(prompt).toContain('## Slices');
    expect(prompt).toContain('### Checkout');
    expect(prompt).toContain('**UI:** CheckoutPage');
  });

  test('includes implementation guidance', () => {
    const sys = buildShoppingCart();
    const prompt = sys.toAIPrompt();
    expect(prompt).toContain('## Implementation Guidance');
    expect(prompt).toContain('append-only event store');
  });
});
