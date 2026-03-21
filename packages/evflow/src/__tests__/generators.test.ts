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

  test('includes aggregates section with invariants', () => {
    const sys = new EventModel('Test');
    sys.command('PlaceOrder', { fields: {} });
    sys.event('OrderPlaced', { fields: {} });
    sys.aggregate('Order', {
      handles: ['PlaceOrder'],
      emits: ['OrderPlaced'],
      invariants: ['items must not be empty'],
      description: 'Order aggregate',
    });
    const prompt = sys.toAIPrompt();
    expect(prompt).toContain('## Aggregates');
    expect(prompt).toContain('### Order');
    expect(prompt).toContain('**Handles:** PlaceOrder');
    expect(prompt).toContain('**Emits:** OrderPlaced');
    expect(prompt).toContain('items must not be empty');
    expect(prompt).toContain('**Description:** Order aggregate');
  });

  test('includes screens section', () => {
    const sys = new EventModel('Test');
    sys.event('E', { fields: {} });
    sys.readModel('CartView', { from: ['E'], fields: {} });
    sys.command('AddItem', { fields: {} });
    sys.screen('ProductPage', {
      displays: ['CartView'],
      triggers: ['AddItem'],
    });
    const prompt = sys.toAIPrompt();
    expect(prompt).toContain('## Screens');
    expect(prompt).toContain('### ProductPage');
    expect(prompt).toContain('**Displays:** CartView');
    expect(prompt).toContain('**Triggers:** AddItem');
  });

  test('includes external systems section', () => {
    const sys = new EventModel('Test');
    sys.command('ChargeCard', { fields: {} });
    sys.event('PaymentReceived', { fields: {} });
    sys.external('Stripe', {
      receives: ['ChargeCard'],
      emits: ['PaymentReceived'],
      description: 'Payment gateway',
    });
    const prompt = sys.toAIPrompt();
    expect(prompt).toContain('## External Systems');
    expect(prompt).toContain('### Stripe');
    expect(prompt).toContain('**Receives:** ChargeCard');
    expect(prompt).toContain('**Emits:** PaymentReceived');
  });

  test('includes sagas section', () => {
    const sys = new EventModel('Test');
    sys.event('OrderPlaced', { fields: {} });
    sys.event('PaymentReceived', { fields: {} });
    sys.command('ShipOrder', { fields: {} });
    sys.saga('OrderFulfillment', {
      on: ['OrderPlaced', 'PaymentReceived'],
      correlationKey: 'orderId',
      when: 'all received',
      triggers: 'ShipOrder',
    });
    const prompt = sys.toAIPrompt();
    expect(prompt).toContain('## Sagas (Process Managers)');
    expect(prompt).toContain('### OrderFulfillment');
    expect(prompt).toContain('**Listens to:** OrderPlaced, PaymentReceived');
    expect(prompt).toContain('**Correlation key:** orderId');
    expect(prompt).toContain('**Condition:** all received');
    expect(prompt).toContain('**Triggers:** ShipOrder');
  });

  test('includes bounded contexts section', () => {
    const sys = new EventModel('Test');
    sys.context('OrderManagement', (ctx) => {
      ctx.command('PlaceOrder', { fields: {} });
      ctx.event('OrderPlaced', { fields: {} });
    });
    const prompt = sys.toAIPrompt();
    expect(prompt).toContain('## Bounded Contexts');
    expect(prompt).toContain('### OrderManagement');
    expect(prompt).toContain('**Elements:** PlaceOrder, OrderPlaced');
  });

  test('includes version in commands and events', () => {
    const sys = new EventModel('Test');
    sys.command('PlaceOrder', { fields: {}, version: 2 });
    sys.event('OrderPlaced', { fields: {}, version: 3 });
    const prompt = sys.toAIPrompt();
    expect(prompt).toContain('**Version:** 2');
    expect(prompt).toContain('**Version:** 3');
  });

  test('includes updated implementation guidance for new concepts', () => {
    const sys = new EventModel('Test');
    const prompt = sys.toAIPrompt();
    expect(prompt).toContain('**Aggregates**');
    expect(prompt).toContain('**Screens**');
    expect(prompt).toContain('**External Systems**');
    expect(prompt).toContain('**Sagas**');
  });
});

describe('toJSON() with new elements', () => {
  test('includes contexts in JSON output', () => {
    const sys = new EventModel('Test');
    sys.context('Ctx', (ctx) => {
      ctx.command('Cmd', { fields: {} });
    });
    const parsed = JSON.parse(sys.toJSON());
    expect(parsed.contexts).toHaveLength(1);
    expect(parsed.contexts[0].name).toBe('Ctx');
  });

  test('includes new element kinds in JSON', () => {
    const sys = new EventModel('Test');
    sys.command('Cmd', { fields: {} });
    sys.event('Evt', { fields: {} });
    sys.aggregate('Agg', { handles: ['Cmd'], emits: ['Evt'] });
    sys.readModel('RM', { from: ['Evt'], fields: {} });
    sys.screen('Scr', { displays: ['RM'], triggers: ['Cmd'] });
    sys.external('Ext', { receives: ['Cmd'], emits: ['Evt'] });
    sys.saga('S', {
      on: ['Evt'],
      correlationKey: 'id',
      when: 'all',
      triggers: 'Cmd',
    });
    const parsed = JSON.parse(sys.toJSON());
    expect(parsed.elements.Agg.kind).toBe('aggregate');
    expect(parsed.elements.Scr.kind).toBe('screen');
    expect(parsed.elements.Ext.kind).toBe('external');
    expect(parsed.elements.S.kind).toBe('saga');
  });
});

// ── Mermaid generator ─────────────────────────────────────────

describe('toMermaid()', () => {
  describe('flowchart mode', () => {
    test('produces valid flowchart header', () => {
      const sys = buildShoppingCart();
      const mermaid = sys.toMermaid();
      expect(mermaid).toStartWith('flowchart LR');
    });

    test('respects direction option', () => {
      const sys = buildShoppingCart();
      const mermaid = sys.toMermaid({ direction: 'TB' });
      expect(mermaid).toStartWith('flowchart TB');
    });

    test('includes classDefs for all element kinds', () => {
      const sys = buildShoppingCart();
      const mermaid = sys.toMermaid();
      expect(mermaid).toContain('classDef command');
      expect(mermaid).toContain('classDef event');
      expect(mermaid).toContain('classDef readModel');
      expect(mermaid).toContain('classDef automation');
      expect(mermaid).toContain('classDef aggregate');
      expect(mermaid).toContain('classDef screen');
      expect(mermaid).toContain('classDef external');
      expect(mermaid).toContain('classDef saga');
    });

    test('renders slice as subgraph', () => {
      const sys = buildShoppingCart();
      const mermaid = sys.toMermaid();
      expect(mermaid).toContain('subgraph Checkout["Checkout"]');
    });

    test('renders command nodes with icon and class', () => {
      const sys = buildShoppingCart();
      const mermaid = sys.toMermaid();
      expect(mermaid).toContain('StartCheckout["📋 StartCheckout"]:::command');
    });

    test('renders event nodes with icon and class', () => {
      const sys = buildShoppingCart();
      const mermaid = sys.toMermaid();
      expect(mermaid).toContain('CheckoutStarted["⚡ CheckoutStarted"]:::event');
    });

    test('renders readModel nodes with stadium shape', () => {
      const sys = buildShoppingCart();
      const mermaid = sys.toMermaid();
      expect(mermaid).toContain('CartView(["📊 CartView"]):::readModel');
    });

    test('renders automation edges from event to command', () => {
      const sys = buildShoppingCart();
      const mermaid = sys.toMermaid();
      expect(mermaid).toContain('CheckoutStarted -- "on" --> TriggerPayment');
      expect(mermaid).toContain('TriggerPayment -- "triggers" --> ProcessPayment');
    });

    test('renders readModel from edges', () => {
      const sys = buildShoppingCart();
      const mermaid = sys.toMermaid();
      expect(mermaid).toContain('ItemAddedToCart -- "projects" --> CartView');
    });

    test('filters by slice when option provided', () => {
      const sys = buildShoppingCart();
      const mermaid = sys.toMermaid({ slice: 'Checkout' });
      expect(mermaid).toContain('subgraph Checkout');
      expect(mermaid).not.toContain('subgraph Ungrouped');
      // Checkout slice has StartCheckout but not AddItemToCart
      expect(mermaid).toContain('StartCheckout');
    });

    test('renders aggregate with hexagon shape', () => {
      const sys = new EventModel('Test');
      const Cmd = sys.command('Cmd', { fields: {} });
      const Evt = sys.event('Evt', { fields: {} });
      sys.aggregate('Agg', { handles: [Cmd], emits: [Evt], invariants: ['inv1'] });
      sys.slice('S', { commands: [Cmd], events: [Evt], aggregates: ['Agg'] });
      const mermaid = sys.toMermaid();
      expect(mermaid).toContain('Agg{{"🔷 Agg"}}:::aggregate');
    });

    test('renders external with double-bordered shape', () => {
      const sys = new EventModel('Test');
      const Cmd = sys.command('Cmd', { fields: {} });
      const Evt = sys.event('Evt', { fields: {} });
      sys.external('Ext', { receives: [Cmd], emits: [Evt] });
      sys.slice('S', { commands: [Cmd], events: [Evt], externals: ['Ext'] });
      const mermaid = sys.toMermaid();
      expect(mermaid).toContain('Ext[["🌐 Ext"]]:::external');
    });

    test('renders screen with edges to readModel and command', () => {
      const sys = new EventModel('Test');
      const Cmd = sys.command('Cmd', { fields: {} });
      const Evt = sys.event('Evt', { fields: {} });
      sys.readModel('RM', { from: [Evt], fields: {} });
      sys.screen('Scr', { displays: ['RM'], triggers: [Cmd] });
      sys.slice('S', {
        commands: [Cmd],
        events: [Evt],
        readModels: ['RM'],
        screens: ['Scr'],
      });
      const mermaid = sys.toMermaid();
      expect(mermaid).toContain('RM -- "displays" --> Scr');
      expect(mermaid).toContain('Scr -- "triggers" --> Cmd');
    });

    test('renders saga edges', () => {
      const sys = new EventModel('Test');
      const Cmd = sys.command('Cmd', { fields: {} });
      const Evt = sys.event('Evt', { fields: {} });
      sys.saga('MySaga', { on: [Evt], correlationKey: 'id', when: 'cond', triggers: [Cmd] });
      sys.slice('S', { commands: [Cmd], events: [Evt], sagas: ['MySaga'] });
      const mermaid = sys.toMermaid();
      expect(mermaid).toContain('Evt -- "listens" --> MySaga');
      expect(mermaid).toContain('MySaga -- "triggers" --> Cmd');
    });
  });

  describe('sequence mode', () => {
    test('produces sequenceDiagram header', () => {
      const sys = buildShoppingCart();
      const mermaid = sys.toMermaid({ mode: 'sequence' });
      expect(mermaid).toContain('sequenceDiagram');
    });

    test('includes sequence name as comment', () => {
      const sys = buildShoppingCart();
      const mermaid = sys.toMermaid({ mode: 'sequence' });
      expect(mermaid).toContain('%% ── Happy Path ──');
    });

    test('renders participants with kind labels', () => {
      const sys = buildShoppingCart();
      const mermaid = sys.toMermaid({ mode: 'sequence' });
      expect(mermaid).toContain('‹command›');
      expect(mermaid).toContain('‹event›');
    });

    test('renders arrows between steps', () => {
      const sys = buildShoppingCart();
      const mermaid = sys.toMermaid({ mode: 'sequence' });
      // Should have arrows from AddItemToCart → ItemAddedToCart etc.
      expect(mermaid).toContain('->>');
    });

    test('filters by sequence name', () => {
      const sys = new EventModel('Test');
      const A = sys.command('A', { fields: {} });
      const B = sys.event('B', { fields: {} });
      const C = sys.command('C', { fields: {} });
      const D = sys.event('D', { fields: {} });
      const { flow } = sys;
      sys.sequence('First', flow`${A} -> ${B}`);
      sys.sequence('Second', flow`${C} -> ${D}`);
      const mermaid = sys.toMermaid({ mode: 'sequence', sequence: 'First' });
      expect(mermaid).toContain('First');
      expect(mermaid).not.toContain('Second');
    });

    test('returns no-sequences message when empty', () => {
      const sys = new EventModel('Empty');
      const mermaid = sys.toMermaid({ mode: 'sequence' });
      expect(mermaid).toContain('No sequences found');
    });
  });
});

// ── React Flow graph generator ─────────────────────────────

function buildFullModel(): EventModel {
  const sys = new EventModel('Full Model');

  const AddItem = sys.command('AddItem', {
    actor: 'User',
    fields: { id: 'string', name: 'string' },
    description: 'Add an item',
  });
  const ItemAdded = sys.event('ItemAdded', {
    fields: { id: 'string', name: 'string' },
  });
  const RemoveItem = sys.command('RemoveItem', {
    actor: 'User',
    fields: { id: 'string' },
  });
  const ItemRemoved = sys.event('ItemRemoved', {
    fields: { id: 'string' },
  });

  const Cart = sys.aggregate('Cart', {
    handles: [AddItem, RemoveItem],
    emits: [ItemAdded, ItemRemoved],
    invariants: ['Item must exist to remove'],
    description: 'Shopping cart aggregate',
  });

  const CartView = sys.readModel('CartView', {
    from: [ItemAdded, ItemRemoved],
    fields: { items: 'Item[]', total: 'number' },
  });

  const CartScreen = sys.screen('CartScreen', {
    displays: [CartView],
    triggers: [AddItem, RemoveItem],
    description: 'Shopping cart UI',
  });

  const PaymentGateway = sys.external('PaymentGateway', {
    receives: [RemoveItem],
    emits: [ItemRemoved],
    description: 'External payment service',
  });

  const AutoNotify = sys.automation('AutoNotify', {
    on: 'ItemAdded',
    triggers: 'RemoveItem',
    description: 'Auto-notify on add',
  });

  const CartSaga = sys.saga('CartSaga', {
    on: [ItemAdded, ItemRemoved],
    correlationKey: 'cartId',
    when: 'both events received',
    triggers: 'AddItem',
  });

  sys.slice('Cart Management', {
    commands: [AddItem, RemoveItem],
    events: [ItemAdded, ItemRemoved],
    aggregates: [Cart],
    readModels: [CartView],
    screens: [CartScreen],
    externals: [PaymentGateway],
    automations: [AutoNotify],
    sagas: [CartSaga],
  });

  return sys;
}

describe('toReactFlowGraph()', () => {
  test('returns nodes and edges arrays', () => {
    const sys = buildShoppingCart();
    const graph = sys.toReactFlowGraph();
    expect(graph.nodes).toBeInstanceOf(Array);
    expect(graph.edges).toBeInstanceOf(Array);
  });

  test('creates a node per element', () => {
    const sys = buildShoppingCart();
    const graph = sys.toReactFlowGraph({ groupBySlice: false });
    // ShoppingCart has 9 elements (3 commands, 3 events, 2 readModels, 1 automation)
    const elementNodes = graph.nodes.filter((n) => n.type === 'evflowNode');
    expect(elementNodes).toHaveLength(9);
  });

  test('node data includes kind and label', () => {
    const sys = buildFullModel();
    const graph = sys.toReactFlowGraph({ groupBySlice: false });
    const addNode = graph.nodes.find((n) => n.id === 'AddItem');
    expect(addNode).toBeDefined();
    expect(addNode!.data.kind).toBe('command');
    expect(addNode!.data.label).toContain('AddItem');
    expect(addNode!.data.label).toContain('📋');
  });

  test('aggregate nodes include invariants', () => {
    const sys = buildFullModel();
    const graph = sys.toReactFlowGraph({ groupBySlice: false });
    const cartNode = graph.nodes.find((n) => n.id === 'Cart');
    expect(cartNode).toBeDefined();
    expect(cartNode!.data.invariants).toContain('Item must exist to remove');
  });

  test('nodes with fields include fields in data', () => {
    const sys = buildFullModel();
    const graph = sys.toReactFlowGraph({ groupBySlice: false });
    const addNode = graph.nodes.find((n) => n.id === 'AddItem');
    expect(addNode!.data.fields).toEqual({ id: 'string', name: 'string' });
  });

  test('creates edges from aggregate handles/emits', () => {
    const sys = buildFullModel();
    const graph = sys.toReactFlowGraph({ groupBySlice: false });
    const handleEdge = graph.edges.find((e) => e.source === 'AddItem' && e.target === 'Cart');
    expect(handleEdge).toBeDefined();
    expect(handleEdge!.label).toBe('handles');

    const emitEdge = graph.edges.find((e) => e.source === 'Cart' && e.target === 'ItemAdded');
    expect(emitEdge).toBeDefined();
    expect(emitEdge!.label).toBe('emits');
  });

  test('creates edges from screen displays/triggers', () => {
    const sys = buildFullModel();
    const graph = sys.toReactFlowGraph({ groupBySlice: false });
    const displayEdge = graph.edges.find(
      (e) => e.source === 'CartView' && e.target === 'CartScreen',
    );
    expect(displayEdge).toBeDefined();
    expect(displayEdge!.label).toBe('displays');

    const triggerEdge = graph.edges.find(
      (e) => e.source === 'CartScreen' && e.target === 'AddItem',
    );
    expect(triggerEdge).toBeDefined();
    expect(triggerEdge!.label).toBe('triggers');
  });

  test('creates edges from readModel from', () => {
    const sys = buildFullModel();
    const graph = sys.toReactFlowGraph({ groupBySlice: false });
    const projectEdge = graph.edges.find(
      (e) => e.source === 'ItemAdded' && e.target === 'CartView',
    );
    expect(projectEdge).toBeDefined();
    expect(projectEdge!.label).toBe('projects');
  });

  test('creates edges from external receives/emits', () => {
    const sys = buildFullModel();
    const graph = sys.toReactFlowGraph({ groupBySlice: false });
    const recvEdge = graph.edges.find(
      (e) => e.source === 'RemoveItem' && e.target === 'PaymentGateway',
    );
    expect(recvEdge).toBeDefined();
    expect(recvEdge!.label).toBe('receives');

    const emitEdge = graph.edges.find(
      (e) => e.source === 'PaymentGateway' && e.target === 'ItemRemoved',
    );
    expect(emitEdge).toBeDefined();
    expect(emitEdge!.label).toBe('emits');
  });

  test('creates edges from automation on/triggers', () => {
    const sys = buildFullModel();
    const graph = sys.toReactFlowGraph({ groupBySlice: false });
    const onEdge = graph.edges.find((e) => e.source === 'ItemAdded' && e.target === 'AutoNotify');
    expect(onEdge).toBeDefined();
    expect(onEdge!.label).toBe('on');

    const triggerEdge = graph.edges.find(
      (e) => e.source === 'AutoNotify' && e.target === 'RemoveItem',
    );
    expect(triggerEdge).toBeDefined();
    expect(triggerEdge!.label).toBe('triggers');
  });

  test('creates edges from saga on/triggers', () => {
    const sys = buildFullModel();
    const graph = sys.toReactFlowGraph({ groupBySlice: false });
    const listenEdge = graph.edges.find((e) => e.source === 'ItemAdded' && e.target === 'CartSaga');
    expect(listenEdge).toBeDefined();
    expect(listenEdge!.label).toBe('listens');

    const triggerEdge = graph.edges.find((e) => e.source === 'CartSaga' && e.target === 'AddItem');
    expect(triggerEdge).toBeDefined();
    expect(triggerEdge!.label).toBe('triggers');
  });

  test('event edges are animated', () => {
    const sys = buildFullModel();
    const graph = sys.toReactFlowGraph({ groupBySlice: false });
    const eventEdge = graph.edges.find((e) => e.target === 'ItemAdded');
    expect(eventEdge).toBeDefined();
    expect(eventEdge!.animated).toBe(true);
  });

  test('slice filtering only includes matching elements', () => {
    const sys = new EventModel('Multi');
    const A = sys.command('A', { fields: {} });
    const B = sys.event('B', { fields: {} });
    const C = sys.command('C', { fields: {} });
    const D = sys.event('D', { fields: {} });
    sys.slice('First', { commands: [A], events: [B] });
    sys.slice('Second', { commands: [C], events: [D] });
    const graph = sys.toReactFlowGraph({ slice: 'First', groupBySlice: false });
    const elementNodes = graph.nodes.filter((n) => n.type === 'evflowNode');
    expect(elementNodes).toHaveLength(2);
    expect(elementNodes.map((n) => n.id)).toContain('A');
    expect(elementNodes.map((n) => n.id)).toContain('B');
  });

  test('groupBySlice creates group nodes', () => {
    const sys = buildFullModel();
    const graph = sys.toReactFlowGraph({ groupBySlice: true });
    const groupNodes = graph.nodes.filter((n) => n.type === 'group');
    expect(groupNodes).toHaveLength(1);
    expect(groupNodes[0].data.label).toBe('Cart Management');
  });

  test('elements in a single slice get parentId', () => {
    const sys = buildFullModel();
    const graph = sys.toReactFlowGraph({ groupBySlice: true });
    const addNode = graph.nodes.find((n) => n.id === 'AddItem');
    expect(addNode!.parentId).toBe('slice:Cart_Management');
    expect(addNode!.extent).toBe('parent');
  });

  test('node data includes slices array', () => {
    const sys = buildFullModel();
    const graph = sys.toReactFlowGraph({ groupBySlice: false });
    const addNode = graph.nodes.find((n) => n.id === 'AddItem');
    expect(addNode!.data.slices).toContain('Cart Management');
  });

  test('edges have smoothstep type', () => {
    const sys = buildFullModel();
    const graph = sys.toReactFlowGraph({ groupBySlice: false });
    for (const edge of graph.edges) {
      expect(edge.type).toBe('smoothstep');
    }
  });

  test('no duplicate edges', () => {
    const sys = buildFullModel();
    const graph = sys.toReactFlowGraph({ groupBySlice: false });
    const edgeIds = graph.edges.map((e) => e.id);
    expect(new Set(edgeIds).size).toBe(edgeIds.length);
  });

  test('description is passed through to node data', () => {
    const sys = buildFullModel();
    const graph = sys.toReactFlowGraph({ groupBySlice: false });
    const cartNode = graph.nodes.find((n) => n.id === 'Cart');
    expect(cartNode!.data.description).toBe('Shopping cart aggregate');
  });

  test('empty model produces empty graph', () => {
    const sys = new EventModel('Empty');
    const graph = sys.toReactFlowGraph();
    expect(graph.nodes).toHaveLength(0);
    expect(graph.edges).toHaveLength(0);
  });

  test('source is passed through to React Flow node data', () => {
    const sys = new EventModel('Test');
    sys.command('Cmd', {
      fields: {},
      source: { file: 'src/cmd.ts', exportName: 'handle', startLine: 10 },
    });
    const graph = sys.toReactFlowGraph({ groupBySlice: false });
    const node = graph.nodes.find((n) => n.id === 'Cmd');
    expect(node!.data.source).toBeDefined();
    expect(node!.data.source!.file).toBe('src/cmd.ts');
    expect(node!.data.source!.exportName).toBe('handle');
    expect(node!.data.source!.startLine).toBe(10);
  });

  test('nodes without source have undefined source in data', () => {
    const sys = new EventModel('Test');
    sys.command('Cmd', { fields: {} });
    const graph = sys.toReactFlowGraph({ groupBySlice: false });
    const node = graph.nodes.find((n) => n.id === 'Cmd');
    expect(node!.data.source).toBeUndefined();
  });
});
