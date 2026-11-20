/**
 * @domain subdomain: Process Management
 * @domain subdomain-type: supporting
 * @domain type: repository
 * @domain layer: infrastructure
 * @domain depends: Filesystem
 *
 * Manages git hooks by reading/writing `.husky/` shell scripts directly.
 * Labels are stored as `# Label` comments; disabled commands use `# [DISABLED]` prefix.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import type { HookType, HookCommand, ProjectHook } from '@funny/shared';
import { HOOK_TYPES } from '@funny/shared';

// ── Husky script helpers ────────────────────────────────

const HUSKY_SHEBANG = '#!/usr/bin/env sh';

/**
 * Generate a shell script from a list of hook commands.
 * Disabled commands are written as comments with a `# [DISABLED]` prefix.
 */
function generateHuskyScript(commands: HookCommand[]): string {
  const lines: string[] = [HUSKY_SHEBANG, ''];

  for (const cmd of commands) {
    const enabled = cmd.enabled !== false;
    if (enabled) {
      lines.push(`# ${cmd.label}`);
      lines.push(cmd.command);
    } else {
      lines.push(`# [DISABLED] ${cmd.label}`);
      // Comment out each line of the command
      for (const line of cmd.command.split('\n')) {
        lines.push(`# ${line}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Parse a Husky shell script into structured commands.
 * Groups lines by comment headers (# Label).
 */
function parseHuskyScript(content: string): HookCommand[] {
  const lines = content.split('\n');
  const commands: HookCommand[] = [];

  let currentLabel: string | null = null;
  let currentLines: string[] = [];
  let isDisabled = false;

  function flush() {
    if (currentLabel && currentLines.length > 0) {
      commands.push({
        label: currentLabel,
        command: currentLines.join('\n').trim(),
        enabled: !isDisabled,
      });
    }
    currentLabel = null;
    currentLines = [];
    isDisabled = false;
  }

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip shebang and source line
    if (trimmed.startsWith('#!') || trimmed.startsWith('. "$(dirname')) continue;

    // Check for disabled label: # [DISABLED] Label
    const disabledMatch = trimmed.match(/^#\s*\[DISABLED\]\s*(.+)$/);
    if (disabledMatch) {
      flush();
      currentLabel = disabledMatch[1];
      isDisabled = true;
      continue;
    }

    // Check for label comment: # Label text
    const labelMatch = trimmed.match(/^#\s+([A-Z].+)$/);
    if (labelMatch && !isDisabled) {
      flush();
      currentLabel = labelMatch[1];
      continue;
    }

    // If we're in a disabled block, collect uncommented lines
    if (isDisabled && trimmed.startsWith('# ')) {
      currentLines.push(trimmed.slice(2));
      continue;
    }

    // Skip empty lines between sections
    if (trimmed === '' && currentLines.length === 0) continue;

    // Collect command lines
    if (trimmed !== '' || currentLines.length > 0) {
      // If no label yet, create a default one
      if (!currentLabel) {
        currentLabel = `Command ${commands.length + 1}`;
      }
      currentLines.push(line);
    }
  }

  flush();
  return commands;
}

// ── Internal helpers ────────────────────────────────────

function ensureHuskyDir(projectPath: string): string {
  const huskyDir = join(projectPath, '.husky');
  if (!existsSync(huskyDir)) {
    mkdirSync(huskyDir, { recursive: true });
  }
  return huskyDir;
}

function readHookCommands(projectPath: string, hookType: HookType): HookCommand[] {
  const hookPath = join(projectPath, '.husky', hookType);
  if (!existsSync(hookPath)) return [];
  const content = readFileSync(hookPath, 'utf-8');
  return parseHuskyScript(content);
}

function writeHookCommands(projectPath: string, hookType: HookType, commands: HookCommand[]): void {
  const huskyDir = ensureHuskyDir(projectPath);
  const hookPath = join(huskyDir, hookType);

  if (commands.length === 0) {
    if (existsSync(hookPath)) unlinkSync(hookPath);
    return;
  }

  const script = generateHuskyScript(commands);
  writeFileSync(hookPath, script, { mode: 0o755 });
}

// ── Public API ──────────────────────────────────────────

/** List all hooks as flat ProjectHook[] for the UI */
export function listHooks(projectPath: string, hookType?: HookType): ProjectHook[] {
  const huskyDir = join(projectPath, '.husky');
  if (!existsSync(huskyDir)) return [];

  const result: ProjectHook[] = [];
  const types = hookType ? [hookType] : HOOK_TYPES;

  for (const type of types) {
    const commands = readHookCommands(projectPath, type);
    for (let i = 0; i < commands.length; i++) {
      const cmd = commands[i];
      result.push({
        hookType: type,
        index: i,
        label: cmd.label,
        command: cmd.command,
        enabled: cmd.enabled !== false,
      });
    }
  }

  return result;
}

/** Add a command to a hook type */
export function addCommand(
  projectPath: string,
  hookType: HookType,
  label: string,
  command: string,
): ProjectHook {
  const commands = readHookCommands(projectPath, hookType);
  const newCmd: HookCommand = { label, command, enabled: true };
  commands.push(newCmd);
  const index = commands.length - 1;

  writeHookCommands(projectPath, hookType, commands);

  return { hookType, index, label, command, enabled: true };
}

/** Update a command within a hook type */
export function updateCommand(
  projectPath: string,
  hookType: HookType,
  index: number,
  data: { label?: string; command?: string; enabled?: boolean; hookType?: HookType },
): void {
  const commands = readHookCommands(projectPath, hookType);
  if (index < 0 || index >= commands.length) {
    throw new Error(`Hook command not found: ${hookType}[${index}]`);
  }

  // If hookType is changing, move the command to the new type
  if (data.hookType && data.hookType !== hookType) {
    const [removed] = commands.splice(index, 1);
    if (data.label !== undefined) removed.label = data.label;
    if (data.command !== undefined) removed.command = data.command;
    if (data.enabled !== undefined) removed.enabled = data.enabled;

    writeHookCommands(projectPath, hookType, commands);

    // Add to new hook type
    const targetCommands = readHookCommands(projectPath, data.hookType);
    targetCommands.push(removed);
    writeHookCommands(projectPath, data.hookType, targetCommands);
  } else {
    const cmd = commands[index];
    if (data.label !== undefined) cmd.label = data.label;
    if (data.command !== undefined) cmd.command = data.command;
    if (data.enabled !== undefined) cmd.enabled = data.enabled;

    writeHookCommands(projectPath, hookType, commands);
  }
}

/** Delete a command from a hook type */
export function deleteCommand(projectPath: string, hookType: HookType, index: number): void {
  const commands = readHookCommands(projectPath, hookType);
  if (index < 0 || index >= commands.length) {
    throw new Error(`Hook command not found: ${hookType}[${index}]`);
  }

  commands.splice(index, 1);
  writeHookCommands(projectPath, hookType, commands);
}

/** Reorder commands within a hook type */
export function reorderCommands(projectPath: string, hookType: HookType, newOrder: number[]): void {
  const commands = readHookCommands(projectPath, hookType);
  if (!commands.length) return;

  const reordered = newOrder.flatMap((i) => (commands[i] ? [commands[i]] : []));
  writeHookCommands(projectPath, hookType, reordered);
}
