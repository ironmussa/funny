# VS Code Plugin

evflow includes a TypeScript Language Service Plugin that provides real-time validation and autocompletion directly in VS Code — no separate extension needed.

## Setup

### 1. Build the plugin

```bash
cd packages/evflow
bun run build:plugin
```

This compiles the plugin to `plugin/index.cjs`.

### 2. Add to tsconfig.json

```json
{
  "compilerOptions": {
    "plugins": [
      { "name": "@funny/evflow/plugin" }
    ]
  }
}
```

### 3. Restart the TS Server

In VS Code: `Cmd+Shift+P` → **"TypeScript: Restart TS Server"**

That's it. The plugin loads automatically.

## Features

### Diagnostics (Error Detection)

The plugin validates string references in real time. Invalid references appear as red squiggly underlines:

```typescript
const system = new EventModel('Shop');
system.command('AddItem', { fields: { id: 'string' } });
system.event('ItemAdded', { fields: { id: 'string' } });

// ✅ Valid — 'ItemAdded' exists and is an event
system.readModel('CartView', { from: ['ItemAdded'], fields: {} });

// ❌ Error — 'ItmeAdded' does not exist (typo)
system.readModel('CartView', { from: ['ItmeAdded'], fields: {} });
//                                     ~~~~~~~~~~
//                                     Unknown event "ItmeAdded"

// ❌ Error — 'AddItem' is a command, not an event
system.readModel('CartView', { from: ['AddItem'], fields: {} });
//                                     ~~~~~~~~
//                                     "AddItem" is a command, expected an event
```

#### What gets validated

| Location | What's checked |
|----------|---------------|
| `readModel({ from: ['...'] })` | Each string must be an existing **event** |
| `automation({ on: '...' })` | Must be an existing **event** |
| `automation({ triggers: '...' })` | Must be an existing **command** |
| `sequence('name', '... -> ...')` | Each step must be a defined element |
| `slice({ commands: ['...'] })` | Must be an existing **command** |
| `slice({ events: ['...'] })` | Must be an existing **event** |
| `slice({ readModels: ['...'] })` | Must be an existing **readModel** |
| `slice({ automations: ['...'] })` | Must be an existing **automation** |

### Autocompletion

When your cursor is inside a string literal in an evflow context, the plugin suggests element names:

```typescript
system.readModel('CartView', {
  from: ['|'],     // ← cursor here: suggests all events
  fields: {},
});

system.automation('Auto', {
  on: '|',         // ← cursor here: suggests all events
  triggers: '|',   // ← cursor here: suggests all commands
});

system.sequence('Flow', '... -> |');  // ← suggests all elements
```

Completions are **filtered by kind** — you only see events when the context expects events, commands when it expects commands, etc.

## How It Works

The plugin hooks into VS Code's built-in TypeScript server. When you open a file:

1. The plugin scans all project files for `system.command()`, `system.event()`, etc. calls
2. It builds a registry of all element names, their kinds, and positions
3. When `getSemanticDiagnostics` is called, it validates string references against the registry
4. When `getCompletionsAtPosition` is called, it suggests matching elements

The registry is rebuilt on each check, so it always reflects the current state of your code.

## Troubleshooting

### Plugin not loading

1. Check `tsconfig.json` has the plugin configured
2. Make sure the plugin is built: `bun run build:plugin`
3. Restart TS Server: `Cmd+Shift+P` → "TypeScript: Restart TS Server"
4. Check the TS Server log: `Cmd+Shift+P` → "TypeScript: Open TS Server log"
   - Look for: `[evflow] Plugin loaded`

### Diagnostics not appearing

- The plugin only checks files that contain evflow method calls (`.command()`, `.event()`, etc.)
- Make sure the element definitions are in the **same project** (same tsconfig scope)
- Declaration files (`.d.ts`) and `node_modules` are skipped

### Plugin changes not taking effect

After modifying plugin source code:

```bash
bun run build:plugin
```

Then restart the TS Server in VS Code.

## Limitations

- The plugin operates at the **editor level only** — it doesn't affect `tsc` command-line output
- Element detection is AST-based — it looks for `<variable>.command(...)` patterns, so heavily dynamic code may not be detected
- The registry is per-project (all files in the tsconfig scope), but does not cross project boundaries
