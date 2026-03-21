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

  // ── Aggregate ─────────────────────────────────────────────

  test('registers an aggregate and returns an ElementRef', () => {
    const sys = new EventModel('Shop');
    sys.command('PlaceOrder', { fields: {} });
    sys.event('OrderPlaced', { fields: {} });
    const ref = sys.aggregate('Order', {
      handles: ['PlaceOrder'],
      emits: ['OrderPlaced'],
      invariants: ['items must not be empty'],
    });
    expect(ref.name).toBe('Order');
    expect(ref.kind).toBe('aggregate');
    const el = sys.getElement('Order');
    expect(el?.kind).toBe('aggregate');
    if (el?.kind === 'aggregate') {
      expect(el.handles).toEqual(['PlaceOrder']);
      expect(el.emits).toEqual(['OrderPlaced']);
      expect(el.invariants).toEqual(['items must not be empty']);
    }
  });

  test('aggregate resolves ElementRef references', () => {
    const sys = new EventModel('Shop');
    const cmd = sys.command('PlaceOrder', { fields: {} });
    const evt = sys.event('OrderPlaced', { fields: {} });
    sys.aggregate('Order', { handles: [cmd], emits: [evt] });
    const el = sys.getElement('Order');
    if (el?.kind === 'aggregate') {
      expect(el.handles).toEqual(['PlaceOrder']);
      expect(el.emits).toEqual(['OrderPlaced']);
    }
  });

  // ── Screen ────────────────────────────────────────────────

  test('registers a screen and returns an ElementRef', () => {
    const sys = new EventModel('Shop');
    sys.event('E', { fields: {} });
    sys.readModel('CartView', { from: ['E'], fields: {} });
    sys.command('AddItem', { fields: {} });
    const ref = sys.screen('ProductPage', {
      displays: ['CartView'],
      triggers: ['AddItem'],
    });
    expect(ref.name).toBe('ProductPage');
    expect(ref.kind).toBe('screen');
    const el = sys.getElement('ProductPage');
    if (el?.kind === 'screen') {
      expect(el.displays).toEqual(['CartView']);
      expect(el.triggers).toEqual(['AddItem']);
    }
  });

  // ── External ──────────────────────────────────────────────

  test('registers an external system and returns an ElementRef', () => {
    const sys = new EventModel('Shop');
    sys.command('ChargeCard', { fields: {} });
    sys.event('PaymentReceived', { fields: {} });
    const ref = sys.external('Stripe', {
      receives: ['ChargeCard'],
      emits: ['PaymentReceived'],
    });
    expect(ref.name).toBe('Stripe');
    expect(ref.kind).toBe('external');
    const el = sys.getElement('Stripe');
    if (el?.kind === 'external') {
      expect(el.receives).toEqual(['ChargeCard']);
      expect(el.emits).toEqual(['PaymentReceived']);
    }
  });

  test('external defaults to empty arrays', () => {
    const sys = new EventModel('Shop');
    sys.external('Webhook', {});
    const el = sys.getElement('Webhook');
    if (el?.kind === 'external') {
      expect(el.receives).toEqual([]);
      expect(el.emits).toEqual([]);
    }
  });

  // ── Saga ──────────────────────────────────────────────────

  test('registers a saga and returns an ElementRef', () => {
    const sys = new EventModel('Shop');
    sys.event('OrderPlaced', { fields: {} });
    sys.event('PaymentReceived', { fields: {} });
    sys.command('ShipOrder', { fields: {} });
    const ref = sys.saga('OrderFulfillment', {
      on: ['OrderPlaced', 'PaymentReceived'],
      correlationKey: 'orderId',
      when: 'all received',
      triggers: 'ShipOrder',
    });
    expect(ref.name).toBe('OrderFulfillment');
    expect(ref.kind).toBe('saga');
    const el = sys.getElement('OrderFulfillment');
    if (el?.kind === 'saga') {
      expect(el.on).toEqual(['OrderPlaced', 'PaymentReceived']);
      expect(el.correlationKey).toBe('orderId');
      expect(el.when).toBe('all received');
      expect(el.triggers).toBe('ShipOrder');
    }
  });

  test('saga resolves array triggers', () => {
    const sys = new EventModel('Shop');
    const evt = sys.event('E', { fields: {} });
    const cmd1 = sys.command('C1', { fields: {} });
    const cmd2 = sys.command('C2', { fields: {} });
    sys.saga('S', {
      on: [evt],
      correlationKey: 'id',
      when: 'done',
      triggers: [cmd1, cmd2],
    });
    const el = sys.getElement('S');
    if (el?.kind === 'saga') {
      expect(el.on).toEqual(['E']);
      expect(el.triggers).toEqual(['C1', 'C2']);
    }
  });

  // ── Context ───────────────────────────────────────────────

  test('context() groups elements and records them in getData().contexts', () => {
    const sys = new EventModel('Shop');
    sys.context('OrderManagement', (ctx) => {
      ctx.command('PlaceOrder', { fields: {} });
      ctx.event('OrderPlaced', { fields: {} });
    });
    const data = sys.getData();
    expect(data.contexts).toHaveLength(1);
    expect(data.contexts[0].name).toBe('OrderManagement');
    expect(data.contexts[0].elements).toEqual(['PlaceOrder', 'OrderPlaced']);
  });

  test('context() elements are still accessible via getElement()', () => {
    const sys = new EventModel('Shop');
    sys.context('Ctx', (ctx) => {
      ctx.command('Cmd', { fields: {} });
    });
    expect(sys.getElement('Cmd')).toBeDefined();
    expect(sys.getElement('Cmd')?.kind).toBe('command');
  });

  // ── Versioning ────────────────────────────────────────────

  test('command accepts optional version field', () => {
    const sys = new EventModel('Shop');
    sys.command('PlaceOrder', { fields: {}, version: 2 });
    const el = sys.getElement('PlaceOrder');
    if (el?.kind === 'command') {
      expect(el.version).toBe(2);
    }
  });

  test('event accepts optional version field', () => {
    const sys = new EventModel('Shop');
    sys.event('OrderPlaced', { fields: {}, version: 3 });
    const el = sys.getElement('OrderPlaced');
    if (el?.kind === 'event') {
      expect(el.version).toBe(3);
    }
  });

  // ── Slice with new kinds ──────────────────────────────────

  test('slice() accepts new element kind arrays', () => {
    const sys = new EventModel('Shop');
    const agg = sys.aggregate('Order', { handles: [], emits: [] });
    const scr = sys.screen('Page', { displays: [], triggers: [] });
    const ext = sys.external('Stripe', {});
    sys.event('E', { fields: {} });
    const saga = sys.saga('S', {
      on: ['E'],
      correlationKey: 'id',
      when: 'all',
      triggers: [],
    });

    sys.slice('Full', {
      aggregates: [agg],
      screens: [scr],
      externals: [ext],
      sagas: [saga],
    });

    const data = sys.getData();
    expect(data.slices[0].aggregates).toEqual(['Order']);
    expect(data.slices[0].screens).toEqual(['Page']);
    expect(data.slices[0].externals).toEqual(['Stripe']);
    expect(data.slices[0].sagas).toEqual(['S']);
  });
});

describe('source references', () => {
  test('command accepts optional source field', () => {
    const sys = new EventModel('Shop');
    sys.command('AddItem', {
      fields: { id: 'string' },
      source: { file: 'src/handlers/add-item.ts', exportName: 'handleAddItem' },
    });
    const el = sys.getElement('AddItem');
    expect(el?.source).toBeDefined();
    expect(el!.source!.file).toBe('src/handlers/add-item.ts');
    expect(el!.source!.exportName).toBe('handleAddItem');
  });

  test('event accepts optional source field', () => {
    const sys = new EventModel('Shop');
    sys.event('ItemAdded', {
      fields: { id: 'string' },
      source: { file: 'src/events/item-added.ts', startLine: 5, endLine: 20 },
    });
    const el = sys.getElement('ItemAdded');
    expect(el!.source!.startLine).toBe(5);
    expect(el!.source!.endLine).toBe(20);
  });

  test('readModel passes source through', () => {
    const sys = new EventModel('Shop');
    sys.event('E', { fields: {} });
    sys.readModel('CartView', {
      from: ['E'],
      fields: {},
      source: { file: 'src/projections/cart-view.ts', startLine: 10, endLine: 50 },
    });
    const el = sys.getElement('CartView');
    expect(el!.source!.file).toBe('src/projections/cart-view.ts');
  });

  test('aggregate passes source through', () => {
    const sys = new EventModel('Shop');
    sys.command('Cmd', { fields: {} });
    sys.event('Evt', { fields: {} });
    sys.aggregate('Agg', {
      handles: ['Cmd'],
      emits: ['Evt'],
      source: { file: 'src/aggregates/agg.ts' },
    });
    const el = sys.getElement('Agg');
    expect(el!.source!.file).toBe('src/aggregates/agg.ts');
  });

  test('screen passes source through', () => {
    const sys = new EventModel('Shop');
    sys.readModel('RM', { from: [], fields: {} });
    sys.command('Cmd', { fields: {} });
    sys.screen('Scr', {
      displays: ['RM'],
      triggers: ['Cmd'],
      source: { file: 'src/screens/scr.tsx' },
    });
    const el = sys.getElement('Scr');
    expect(el!.source!.file).toBe('src/screens/scr.tsx');
  });

  test('external passes source through', () => {
    const sys = new EventModel('Shop');
    sys.external('Ext', {
      source: { file: 'src/external/stripe.ts', exportName: 'StripeAdapter' },
    });
    const el = sys.getElement('Ext');
    expect(el!.source!.exportName).toBe('StripeAdapter');
  });

  test('saga passes source through', () => {
    const sys = new EventModel('Shop');
    sys.event('Evt', { fields: {} });
    sys.command('Cmd', { fields: {} });
    sys.saga('S', {
      on: ['Evt'],
      correlationKey: 'id',
      when: 'all',
      triggers: 'Cmd',
      source: { file: 'src/sagas/s.ts' },
    });
    const el = sys.getElement('S');
    expect(el!.source!.file).toBe('src/sagas/s.ts');
  });

  test('source field survives JSON roundtrip', () => {
    const sys = new EventModel('Shop');
    sys.command('Cmd', {
      fields: {},
      source: { file: 'src/cmd.ts', exportName: 'handler', content: 'const x = 1;' },
    });
    const json = sys.toJSON();
    const parsed = JSON.parse(json);
    expect(parsed.elements.Cmd.source.file).toBe('src/cmd.ts');
    expect(parsed.elements.Cmd.source.content).toBe('const x = 1;');
  });

  test('elements without source have undefined source', () => {
    const sys = new EventModel('Shop');
    sys.command('Cmd', { fields: {} });
    const el = sys.getElement('Cmd');
    expect(el!.source).toBeUndefined();
  });
});
