# Plan: Startup Commands per Project

## Overview
Add a button in the ThreadView header (next to the cost display and GitCompare icon) that opens a popover/dropdown to configure and execute startup commands per project. Each project can have multiple commands (e.g., `npm run dev`, `npm run build`) that launch in terminal tabs.

## Changes

### 1. Database: New `startup_commands` table
**File:** `packages/server/src/db/schema.ts`
- Add a `startupCommands` table with columns: `id`, `projectId`, `label`, `command`, `order`, `createdAt`

**File:** `packages/server/src/db/migrate.ts`
- Add `CREATE TABLE IF NOT EXISTS startup_commands` in `autoMigrate()`

### 2. Shared Types
**File:** `packages/shared/src/types.ts`
- Add `StartupCommand` interface: `{ id, projectId, label, command, order, createdAt }`

### 3. Server API Routes
**File:** `packages/server/src/routes/projects.ts`
- `GET /api/projects/:id/commands` — list startup commands for a project
- `POST /api/projects/:id/commands` — add a startup command (body: `{ label, command }`)
- `PUT /api/projects/:id/commands/:cmdId` — update a command
- `DELETE /api/projects/:id/commands/:cmdId` — delete a command

### 4. Client API
**File:** `packages/client/src/lib/api.ts`
- Add methods: `listCommands(projectId)`, `addCommand(projectId, label, command)`, `updateCommand(projectId, cmdId, label, command)`, `deleteCommand(projectId, cmdId)`

### 5. New UI Component: `StartupCommandsPopover`
**File:** `packages/client/src/components/StartupCommandsPopover.tsx`
- A Popover (using Radix/shadcn) triggered by a `Play` (or `Terminal`) icon button in the thread header
- Shows the list of startup commands for the current project
- Each command row has: label, command text, a play button to execute, and edit/delete buttons
- An "Add command" form at the bottom (label + command inputs)
- Clicking play opens a new terminal tab via `useTerminalStore.addTab()` and writes the command into it via Tauri's `pty_write`

### 6. Integration in ThreadView
**File:** `packages/client/src/components/ThreadView.tsx`
- Import `StartupCommandsPopover`
- Place the popover trigger button in the thread header `<div className="flex items-center gap-2">` (line 189), next to the cost and GitCompare button
- Pass the current project ID (derived from `activeThread.projectId` or `selectedProjectId`)

### 7. Terminal execution
- When user clicks "play" on a command, create a new terminal tab with `useTerminalStore.addTab()` using the project's path as `cwd`
- After a short delay (to let PTY spawn), write the command + Enter into the terminal via Tauri's `invoke('pty_write', { id, data: command + '\r' })`
- In non-Tauri (browser) mode, fall back to a server-side endpoint that runs the command (or show a "terminal only in desktop" message)
