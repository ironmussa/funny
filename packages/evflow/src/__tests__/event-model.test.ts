import { describe, test, expect } from 'bun:test';

import { EventModel } from '../event-model.js';

describe('EventModel', () => {
  test('creates a system with a name', () => {
    const sys = new EventModel('Shop');
    expect(sys.name).toBe('Shop');
  });

  test('registers a command and returns an ElementRef', () => {
    const sys = new EventModel('Shop');
    const ref = sys.command('AddItem', { fields: { id: 'string' } });
    expect(ref.name).toBe('AddItem');
    expect(ref.kind).toBe('command');
    expect(ref.toString()).toBe('AddItem');
  });

  test('registers an event and returns an ElementRef', () => {
    const sys = new EventModel('Shop');
    const ref = sys.event('ItemAdded', { fields: { id: 'string' } });
    expect(ref.name).toBe('ItemAdded');
    expect(ref.kind).toBe('event');
  });

  test('registers a readModel with from and fields', () => {
    const sys = new EventModel('Shop');
    sys.event('ItemAdded', { fields: { id: 'string' } });
    const ref = sys.readModel('CartView', {
      from: ['ItemAdded'],
      fields: { items: 'CartItem[]' },
    });
    expect(ref.kind).toBe('readModel');
    const el = sys.getElement('CartView');
    expect(el?.kind).toBe('readModel');
    if (el?.kind === 'readModel') {
      expect(el.from).toEqual(['ItemAdded']);
    }
  });

  test('registers an automation with on and triggers', () => {
    const sys = new EventModel('Shop');
    sys.event('CheckoutStarted', { fields: {} });
    sys.command('ProcessPayment', { fields: {} });
    const ref = sys.automation('TriggerPayment', {
      on: 'CheckoutStarted',
      triggers: 'ProcessPayment',
    });
    expect(ref.kind).toBe('automation');
  });

  test('throws on duplicate element names', () => {
    const sys = new EventModel('Shop');
    sys.command('AddItem', { fields: {} });
    expect(() => sys.command('AddItem', { fields: {} })).toThrow('already defined');
  });

  test('sequence() accepts flow tagged template result', () => {
    const sys = new EventModel('Shop');
    const AddItem = sys.command('AddItem', { fields: { id: 'string' } });
    const ItemAdded = sys.event('ItemAdded', { fields: { id: 'string' } });
    const { flow } = sys;

    sys.sequence('Happy Path', flow`${AddItem} -> ${ItemAdded}`);

    const data = sys.getData();
    expect(data.sequences).toHaveLength(1);
    expect(data.sequences[0].steps).toEqual(['AddItem', 'ItemAdded']);
  });

  test('sequence() accepts string notation', () => {
    const sys = new EventModel('Shop');
    sys.command('AddItem', { fields: {} });
    sys.event('ItemAdded', { fields: {} });

    sys.sequence('Flow', 'AddItem -> ItemAdded');

    const data = sys.getData();
    expect(data.sequences[0].steps).toEqual(['AddItem', 'ItemAdded']);
  });

  test('slice() resolves ElementRef and string references', () => {
    const sys = new EventModel('Shop');
    const AddItem = sys.command('AddItem', { fields: {} });
    sys.event('ItemAdded', { fields: {} });
    const CartView = sys.readModel('CartView', { from: ['ItemAdded'], fields: {} });

    sys.slice('Add to Cart', {
      ui: 'ProductPage',
      commands: [AddItem],
      events: ['ItemAdded'],
      readModels: [CartView],
    });

    const data = sys.getData();
    expect(data.slices).toHaveLength(1);
    expect(data.slices[0].commands).toEqual(['AddItem']);
    expect(data.slices[0].events).toEqual(['ItemAdded']);
    expect(data.slices[0].readModels).toEqual(['CartView']);
    expect(data.slices[0].ui).toBe('ProductPage');
  });

  test('validate() returns ok with no errors on valid model', () => {
    const sys = new EventModel('Shop');
    sys.command('AddItem', { fields: { id: 'string' } });
    sys.event('ItemAdded', { fields: { id: 'string' } });
    sys.readModel('CartView', { from: ['ItemAdded'], fields: {} });
    sys.sequence('Flow', 'AddItem -> ItemAdded');

    const result = sys.validate();
    expect(result.isOk()).toBe(true);
  });

  test('validate() returns err when readModel references unknown event', () => {
    const sys = new EventModel('Shop');
    sys.readModel('CartView', { from: ['NonExistent'], fields: {} });

    const result = sys.validate();
    expect(result.isErr()).toBe(true);
  });

  test('getData() returns a snapshot', () => {
    const sys = new EventModel('Shop');
    sys.command('A', { fields: {} });
    const data = sys.getData();
    expect(data.name).toBe('Shop');
    expect(data.elements.size).toBe(1);
    // Snapshot is independent — adding more elements doesn't change it
    sys.command('B', { fields: {} });
    expect(data.elements.size).toBe(1);
  });

  test('getElement() returns the definition', () => {
    const sys = new EventModel('Shop');
    sys.command('AddItem', { actor: 'Customer', fields: { id: 'string' } });
    const el = sys.getElement('AddItem');
    expect(el?.kind).toBe('command');
    if (el?.kind === 'command') {
      expect(el.actor).toBe('Customer');
    }
  });

  test('getElement() returns undefined for unknown', () => {
    const sys = new EventModel('Shop');
    expect(sys.getElement('Ghost')).toBeUndefined();
  });
});
