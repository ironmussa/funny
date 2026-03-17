# Examples

## From Problem to Event Model

Each example follows the same process:

1. **Describe the problem** — what does the business need?
2. **Identify the actors** — who interacts with the system?
3. **Discover the events** — what facts does the system record?
4. **Design the commands** — what actions produce those events?
5. **Define the read models** — what views does the UI need?
6. **Wire the automations** — what reactions happen automatically?
7. **Draw the sequences** — what's the temporal flow?

This mirrors the [Event Modeling](https://eventmodeling.org/) workshop process, but in code instead of sticky notes.

---

## Example 1: E-Commerce Shopping Cart

### The Problem

We need to build an online store where customers can browse products, add items to a cart, modify their cart, go through checkout, pay, and receive an order confirmation. The system needs to handle payment failures gracefully — the customer should be able to retry without losing their cart.

### Understanding the Domain

Let's start by asking the key questions:

**Who are the actors?**
- **Customer** — browses, adds items, checks out
- **System** — processes payments, sends emails (no human involved)

**What are the important things that happen? (Events)**

Walking through a customer's journey chronologically:

1. Customer adds a product → **ItemAddedToCart**
2. Customer removes a product → **ItemRemovedFromCart**
3. Customer initiates checkout → **CheckoutStarted**
4. Payment goes through → **PaymentSucceeded**
5. Payment is rejected → **PaymentFailed**
6. Order is finalized → **OrderConfirmed**

**What actions produce those events? (Commands)**

Each event has a cause:

| Event | Caused by | Who |
|-------|-----------|-----|
| ItemAddedToCart | **AddItemToCart** | Customer |
| ItemRemovedFromCart | **RemoveItemFromCart** | Customer |
| CheckoutStarted | **StartCheckout** | Customer |
| PaymentSucceeded / PaymentFailed | **ProcessPayment** | System (automated) |
| OrderConfirmed | (automation after payment) | System |

**What does the UI need to display? (Read Models)**

- **CartView** — current items in the cart, subtotal (built from ItemAddedToCart + ItemRemovedFromCart)
- **OrderStatus** — order progress: pending → paid → confirmed (built from CheckoutStarted + PaymentSucceeded + PaymentFailed + OrderConfirmed)

**What should happen automatically? (Automations)**

- When checkout starts → process the payment automatically
- When payment succeeds → confirm the order and send a confirmation email

### Translating to evflow

Now we have all the pieces. Let's write it:

```typescript
import { EventModel } from '@funny/evflow';

const system = new EventModel('E-Commerce');

// ─── Step 1: Define Commands (what actors can do) ────────────

const AddItemToCart = system.command('AddItemToCart', {
  actor: 'Customer',
  fields: { cart_id: 'string', product_id: 'string', quantity: 'number' },
});

const RemoveItemFromCart = system.command('RemoveItemFromCart', {
  actor: 'Customer',
  fields: { cart_id: 'string', product_id: 'string' },
});

const StartCheckout = system.command('StartCheckout', {
  actor: 'Customer',
  fields: { cart_id: 'string', shipping_address: 'Address' },
});

const ProcessPayment = system.command('ProcessPayment', {
  actor: 'System',
  description: 'Triggered automatically, not by a human',
  fields: { order_id: 'string', amount: 'decimal', payment_method: 'string' },
});

const SendEmail = system.command('SendEmail', {
  actor: 'System',
  fields: { to: 'string', template: 'string', data: 'object' },
});

// ─── Step 2: Define Events (what happened — immutable facts) ─

const ItemAddedToCart = system.event('ItemAddedToCart', {
  fields: {
    cart_id: 'string', product_id: 'string',
    name: 'string', price: 'decimal', quantity: 'number', added_at: 'datetime',
  },
});

const ItemRemovedFromCart = system.event('ItemRemovedFromCart', {
  fields: { cart_id: 'string', product_id: 'string', removed_at: 'datetime' },
});

const CheckoutStarted = system.event('CheckoutStarted', {
  fields: {
    cart_id: 'string', order_id: 'string',
    items: 'CartItem[]', subtotal: 'decimal', started_at: 'datetime',
  },
});

const PaymentSucceeded = system.event('PaymentSucceeded', {
  fields: {
    order_id: 'string', amount: 'decimal',
    transaction_id: 'string', paid_at: 'datetime',
  },
});

const PaymentFailed = system.event('PaymentFailed', {
  description: 'Cart is NOT cleared — customer can retry',
  fields: { order_id: 'string', reason: 'string', failed_at: 'datetime' },
});

const OrderConfirmed = system.event('OrderConfirmed', {
  fields: {
    order_id: 'string', items: 'CartItem[]',
    total: 'decimal', confirmed_at: 'datetime',
  },
});

// ─── Step 3: Define Read Models (what the UI shows) ──────────
//
// Each read model says: "I project from these events"
// This is how we answer "where does the data come from?"

system.readModel('CartView', {
  description: 'Sidebar cart widget — items, quantities, subtotal',
  from: ['ItemAddedToCart', 'ItemRemovedFromCart'],
  fields: {
    cart_id: 'string',
    items: 'CartItem[]',
    item_count: 'number',
    subtotal: 'decimal',
  },
});

system.readModel('OrderStatus', {
  description: 'Order tracking page — current state of an order',
  from: ['CheckoutStarted', 'PaymentSucceeded', 'PaymentFailed', 'OrderConfirmed'],
  fields: {
    order_id: 'string',
    status: 'string',   // pending_payment | paid | confirmed | failed
    items: 'CartItem[]',
    total: 'decimal',
  },
});

// ─── Step 4: Define Automations (reactions between events) ───
//
// These answer: "when X happens, what should the system do next?"

const TriggerPayment = system.automation('TriggerPayment', {
  on: 'CheckoutStarted',
  triggers: 'ProcessPayment',
  description: 'When checkout starts, automatically charge the card',
});

const ConfirmOrder = system.automation('ConfirmOrder', {
  on: 'PaymentSucceeded',
  triggers: 'SendEmail',
  description: 'When payment succeeds, send the confirmation email',
});

// ─── Step 5: Define Sequences (the temporal story) ───────────
//
// Sequences are the heart of the model. They tell the complete
// story of "what happens when..." for each scenario.

const { flow } = system;

// The happy path: customer buys something successfully
system.sequence('Happy Path — Purchase', flow`
  ${AddItemToCart} -> ${ItemAddedToCart}
  -> ${StartCheckout} -> ${CheckoutStarted}
  -> ${TriggerPayment} -> ${ProcessPayment} -> ${PaymentSucceeded}
  -> ${ConfirmOrder} -> ${OrderConfirmed}
`);

// The sad path: payment fails, customer can retry
system.sequence('Payment Fails', flow`
  ${AddItemToCart} -> ${ItemAddedToCart}
  -> ${StartCheckout} -> ${CheckoutStarted}
  -> ${TriggerPayment} -> ${ProcessPayment} -> ${PaymentFailed}
`);
// Note: cart is NOT cleared on failure — customer can fix payment and retry

// Customer browsing: adding and removing items
system.sequence('Modify Cart', flow`
  ${AddItemToCart} -> ${ItemAddedToCart}
  -> ${RemoveItemFromCart} -> ${ItemRemovedFromCart}
`);

// ─── Step 6: Define Slices (vertical cuts for implementation) ─
//
// Each slice groups UI + commands + events + read models that
// belong to the same feature. This maps to a sprint or a story.

system.slice('Browse & Add', {
  ui: 'ProductPage',
  commands: [AddItemToCart],
  events: [ItemAddedToCart],
  readModels: ['CartView'],
});

system.slice('Review Cart', {
  ui: 'CartPage',
  commands: [RemoveItemFromCart],
  events: [ItemRemovedFromCart],
  readModels: ['CartView'],
});

system.slice('Checkout & Payment', {
  ui: 'CheckoutPage',
  commands: [StartCheckout],
  events: [CheckoutStarted, PaymentSucceeded, PaymentFailed],
  readModels: ['OrderStatus'],
  automations: [TriggerPayment],
});

system.slice('Order Confirmation', {
  ui: 'ConfirmationPage',
  events: [OrderConfirmed],
  readModels: ['OrderStatus'],
  automations: [ConfirmOrder],
});

// ─── Output ──────────────────────────────────────────────────

// Validate: are there orphan events? Missing references?
const result = system.validate();
result.match(
  (warnings) => {
    if (warnings.length > 0) console.log('Warnings:', warnings);
    else console.log('Model is valid!');
  },
  (errors) => {
    for (const e of errors) console.error(`[${e.code}] ${e.message}`);
  },
);

// Generate a prompt for an AI to implement the system
console.log(system.toAIPrompt());
```

### What this model tells you

Reading the sequences alone, you can understand the entire system:

```
Happy Path:
  Customer clicks "Add to Cart" → item is added → Customer clicks "Checkout"
  → checkout starts → SYSTEM auto-charges card → payment succeeds
  → SYSTEM sends email → order is confirmed

Payment Fails:
  ...same start... → SYSTEM charges card → payment fails
  (cart stays intact, customer can try again)
```

A developer, a product manager, or an AI can read this and know exactly what to build.

---

## Example 2: User Authentication

### The Problem

We need a user authentication system with registration, login, and password reset. Key requirements:

- New users register with email and password
- Users get a welcome email after registration
- After 5 failed login attempts, the account is temporarily locked
- Users can reset their password via email link
- We need to track login attempts for security auditing

### Thinking Through the Events

Let's walk through each user journey:

**Registration journey:**
1. Visitor fills the registration form and submits → **Register** (command)
2. Account is created → **UserRegistered** (event)
3. System sends welcome email → **SendEmail** (automation)

**Login journey (success):**
1. User enters credentials → **Login** (command)
2. Credentials match → **LoginSucceeded** (event)

**Login journey (failure):**
1. User enters wrong credentials → **Login** (command)
2. Credentials don't match → **LoginFailed** (event)
3. After 5 failures → account locked (the read model tracks this)

**Password reset journey:**
1. User clicks "Forgot password" → **RequestPasswordReset** (command)
2. Reset token is generated → **PasswordResetRequested** (event)
3. System sends reset email → **SendEmail** (automation)
4. User clicks link and sets new password → **ResetPassword** (command)
5. Password is updated → **PasswordChanged** (event)

**Key insight:** the read model **LoginAttempts** tracks failed attempts and computes the `locked` flag — no separate "LockAccount" command needed. The read model derives the state from events.

### Translating to evflow

```typescript
import { EventModel } from '@funny/evflow';

const system = new EventModel('Authentication');

// ─── Actors ──────────────────────────────────────────────────
// Visitor = not logged in
// User = logged in
// System = automated (emails)

// ─── Commands ────────────────────────────────────────────────

const Register = system.command('Register', {
  actor: 'Visitor',
  description: 'New user creates an account',
  fields: { email: 'string', password: 'string', name: 'string' },
});

const Login = system.command('Login', {
  actor: 'Visitor',
  description: 'User attempts to log in',
  fields: { email: 'string', password: 'string' },
});

const RequestPasswordReset = system.command('RequestPasswordReset', {
  actor: 'User',
  description: 'User clicks "Forgot password"',
  fields: { email: 'string' },
});

const ResetPassword = system.command('ResetPassword', {
  actor: 'User',
  description: 'User sets a new password via the reset link',
  fields: { token: 'string', new_password: 'string' },
});

const SendEmail = system.command('SendEmail', {
  actor: 'System',
  fields: { to: 'string', template: 'string' },
});

// ─── Events ──────────────────────────────────────────────────

const UserRegistered = system.event('UserRegistered', {
  fields: {
    user_id: 'uuid', email: 'string',
    name: 'string', registered_at: 'datetime',
  },
});

const LoginSucceeded = system.event('LoginSucceeded', {
  fields: { user_id: 'uuid', session_id: 'string', logged_in_at: 'datetime' },
});

const LoginFailed = system.event('LoginFailed', {
  description: 'Tracked for security — 5 failures locks the account',
  fields: { email: 'string', reason: 'string', attempted_at: 'datetime' },
});

const PasswordResetRequested = system.event('PasswordResetRequested', {
  fields: { user_id: 'uuid', token: 'string', requested_at: 'datetime' },
});

const PasswordChanged = system.event('PasswordChanged', {
  fields: { user_id: 'uuid', changed_at: 'datetime' },
});

// ─── Read Models ─────────────────────────────────────────────

system.readModel('UserProfile', {
  description: 'User settings page — name, email, last password change',
  from: ['UserRegistered', 'PasswordChanged'],
  fields: {
    user_id: 'uuid', email: 'string', name: 'string',
    last_password_change: 'datetime',
  },
});

system.readModel('LoginAttempts', {
  description: 'Security dashboard — tracks failed attempts, auto-locks after 5',
  from: ['LoginSucceeded', 'LoginFailed'],
  fields: {
    email: 'string',
    attempts: 'number',         // failed attempts since last success
    last_attempt: 'datetime',
    locked: 'boolean',          // derived: attempts >= 5
  },
});

// ─── Automations ─────────────────────────────────────────────

const WelcomeEmail = system.automation('WelcomeEmail', {
  on: 'UserRegistered',
  triggers: 'SendEmail',
  description: 'Send a welcome email right after registration',
});

const ResetEmail = system.automation('ResetEmail', {
  on: 'PasswordResetRequested',
  triggers: 'SendEmail',
  description: 'Send the password reset link via email',
});

// ─── Sequences ───────────────────────────────────────────────

const { flow } = system;

system.sequence('Registration', flow`
  ${Register} -> ${UserRegistered} -> ${WelcomeEmail}
`);
// Visitor registers → account created → welcome email sent automatically

system.sequence('Login Success', flow`
  ${Login} -> ${LoginSucceeded}
`);
// User logs in → session created. LoginAttempts resets the counter.

system.sequence('Login Failure', flow`
  ${Login} -> ${LoginFailed}
`);
// Wrong password → failure recorded. LoginAttempts increments counter.
// After 5 failures, the read model sets locked=true.
// The Login command handler checks LoginAttempts.locked before proceeding.

system.sequence('Password Reset', flow`
  ${RequestPasswordReset} -> ${PasswordResetRequested}
  -> ${ResetEmail}
  -> ${ResetPassword} -> ${PasswordChanged}
`);
// User requests reset → token generated → email sent automatically
// → user clicks link → password changed

console.log(system.toAIPrompt());
```

### Design decisions visible in the model

1. **No "LockAccount" command** — locking is derived from events. The `LoginAttempts` read model counts failures and sets `locked=true` after 5. This is a common Event Sourcing pattern: let the read model compute state.

2. **LoginSucceeded resets the counter** — because `LoginAttempts` projects from both events, a successful login implicitly resets the failure count.

3. **Two actors for the same person** — "Visitor" (not authenticated) sends `Register` and `Login`. "User" (authenticated) sends `RequestPasswordReset`. This makes access control explicit.

---

## Example 3: Task Management (Kanban Board)

### The Problem

A simple Kanban board where teams can create tasks, move them across columns (Todo → In Progress → Done), assign team members, and add comments. Managers need a dashboard showing workload distribution.

### Discovering the Events

Walking through a task's lifecycle:

| What happens | Event | Who causes it |
|-------------|-------|---------------|
| New task is created | **TaskCreated** | Team Member |
| Task is assigned to someone | **TaskAssigned** | Team Member |
| Task moves to a new column | **TaskMoved** | Team Member |
| Someone adds a comment | **CommentAdded** | Team Member |
| Task is completed | **TaskCompleted** | Team Member |
| Task is archived | **TaskArchived** | Manager |

**Read models needed:**
- **BoardView** — the Kanban board itself: columns with tasks
- **TaskDetail** — a single task with its history and comments
- **WorkloadDashboard** — how many tasks per person, per status

### Translating to evflow

```typescript
import { EventModel } from '@funny/evflow';

const system = new EventModel('Kanban Board');

// ─── Commands ────────────────────────────────────────────────

const CreateTask = system.command('CreateTask', {
  actor: 'TeamMember',
  fields: { title: 'string', description: 'string', column: 'string' },
});

const AssignTask = system.command('AssignTask', {
  actor: 'TeamMember',
  fields: { task_id: 'uuid', assignee_id: 'uuid' },
});

const MoveTask = system.command('MoveTask', {
  actor: 'TeamMember',
  description: 'Drag a card from one column to another',
  fields: { task_id: 'uuid', from_column: 'string', to_column: 'string' },
});

const AddComment = system.command('AddComment', {
  actor: 'TeamMember',
  fields: { task_id: 'uuid', body: 'string' },
});

const ArchiveTask = system.command('ArchiveTask', {
  actor: 'Manager',
  fields: { task_id: 'uuid' },
});

const NotifyUser = system.command('NotifyUser', {
  actor: 'System',
  fields: { user_id: 'uuid', message: 'string', link: 'string' },
});

// ─── Events ──────────────────────────────────────────────────

const TaskCreated = system.event('TaskCreated', {
  fields: {
    task_id: 'uuid', title: 'string', description: 'string',
    column: 'string', created_by: 'uuid', created_at: 'datetime',
  },
});

const TaskAssigned = system.event('TaskAssigned', {
  fields: {
    task_id: 'uuid', assignee_id: 'uuid',
    assigned_by: 'uuid', assigned_at: 'datetime',
  },
});

const TaskMoved = system.event('TaskMoved', {
  fields: {
    task_id: 'uuid', from_column: 'string',
    to_column: 'string', moved_by: 'uuid', moved_at: 'datetime',
  },
});

const CommentAdded = system.event('CommentAdded', {
  fields: {
    task_id: 'uuid', comment_id: 'uuid',
    body: 'string', author_id: 'uuid', added_at: 'datetime',
  },
});

const TaskCompleted = system.event('TaskCompleted', {
  description: 'Emitted when task is moved to the "Done" column',
  fields: { task_id: 'uuid', completed_by: 'uuid', completed_at: 'datetime' },
});

const TaskArchived = system.event('TaskArchived', {
  fields: { task_id: 'uuid', archived_by: 'uuid', archived_at: 'datetime' },
});

// ─── Read Models ─────────────────────────────────────────────

system.readModel('BoardView', {
  description: 'The Kanban board — tasks grouped by column',
  from: ['TaskCreated', 'TaskMoved', 'TaskArchived'],
  fields: {
    columns: 'Column[]',   // each column has a list of task cards
  },
});

system.readModel('TaskDetail', {
  description: 'Full task view — info, history, and comments thread',
  from: ['TaskCreated', 'TaskAssigned', 'TaskMoved', 'CommentAdded', 'TaskCompleted'],
  fields: {
    task_id: 'uuid', title: 'string', description: 'string',
    assignee: 'User', column: 'string', comments: 'Comment[]',
    history: 'HistoryEntry[]',
  },
});

system.readModel('WorkloadDashboard', {
  description: 'Manager view — tasks per person, per status',
  from: ['TaskCreated', 'TaskAssigned', 'TaskMoved', 'TaskCompleted'],
  fields: {
    members: 'MemberWorkload[]',  // { user, todo_count, in_progress_count, done_count }
    total_tasks: 'number',
    completion_rate: 'number',
  },
});

// ─── Automations ─────────────────────────────────────────────

const NotifyAssignee = system.automation('NotifyAssignee', {
  on: 'TaskAssigned',
  triggers: 'NotifyUser',
  description: 'Notify the person when a task is assigned to them',
});

const NotifyOnComment = system.automation('NotifyOnComment', {
  on: 'CommentAdded',
  triggers: 'NotifyUser',
  description: 'Notify task assignee when someone comments',
});

// ─── Sequences ───────────────────────────────────────────────

const { flow } = system;

// Full lifecycle of a task
system.sequence('Task Lifecycle', flow`
  ${CreateTask} -> ${TaskCreated}
  -> ${AssignTask} -> ${TaskAssigned} -> ${NotifyAssignee}
  -> ${MoveTask} -> ${TaskMoved}
  -> ${MoveTask} -> ${TaskCompleted}
  -> ${ArchiveTask} -> ${TaskArchived}
`);

// Collaboration: someone comments on a task
system.sequence('Comment on Task', flow`
  ${AddComment} -> ${CommentAdded} -> ${NotifyOnComment}
`);

// Quick task: create and assign immediately
system.sequence('Create and Assign', flow`
  ${CreateTask} -> ${TaskCreated}
  -> ${AssignTask} -> ${TaskAssigned} -> ${NotifyAssignee}
`);

// ─── Slices ──────────────────────────────────────────────────

system.slice('Kanban Board', {
  ui: 'BoardPage',
  commands: [CreateTask, MoveTask],
  events: [TaskCreated, TaskMoved],
  readModels: ['BoardView'],
});

system.slice('Task Detail', {
  ui: 'TaskModal',
  commands: [AssignTask, AddComment],
  events: [TaskAssigned, CommentAdded],
  readModels: ['TaskDetail'],
  automations: [NotifyAssignee, NotifyOnComment],
});

system.slice('Manager Dashboard', {
  ui: 'DashboardPage',
  commands: [ArchiveTask],
  events: [TaskArchived],
  readModels: ['WorkloadDashboard'],
});

// Validate and generate
system.validate();
console.log(system.toAIPrompt());
```

### What the model reveals

- **TaskCompleted is separate from TaskMoved** — moving to "Done" emits both `TaskMoved` and `TaskCompleted`. This lets the `WorkloadDashboard` track completions without knowing about column names.

- **WorkloadDashboard builds from 4 events** — it doesn't query a database. It listens to task creation, assignment, movement, and completion to maintain a real-time view.

- **Notifications are automations, not commands** — the team member doesn't click "notify". The system reacts automatically to assignments and comments.

---

## The Process: How to Build Your Own Model

1. **Start with the events** — ask "what are the important things that happen in this system?" Write them in past tense: UserRegistered, OrderPlaced, TaskCompleted.

2. **Work backwards to commands** — for each event, ask "what action causes this?" and "who performs it?" This gives you commands and actors.

3. **Identify the read models** — for each screen in the UI, ask "what data does it need?" and "from which events can we build that data?"

4. **Wire the automations** — ask "when X happens, should the system do something automatically?" Each "yes" is an automation.

5. **Draw the sequences** — walk through each user story chronologically. The happy path first, then the sad paths.

6. **Validate** — run `system.validate()`. It catches orphan events (defined but never used), missing references, and inconsistencies.

7. **Generate** — run `system.toAIPrompt()` and give it to an AI to implement, or use `system.toJSON()` for tooling integration.
