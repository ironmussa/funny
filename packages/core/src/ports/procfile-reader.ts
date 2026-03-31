import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

import type { FunnyProcessConfig } from '@funny/shared';

/**
 * Parse a Procfile from the project root directory.
 * Format: `name: command` (one per line, # for comments).
 * Procfile processes default to autoRestart: true.
 */
export function readProcfile(projectPath: string): FunnyProcessConfig[] {
  const procfilePath = resolve(projectPath, 'Procfile');
  if (!existsSync(procfilePath)) return [];

  let content: string;
  try {
    content = readFileSync(procfilePath, 'utf-8');
  } catch {
    return [];
  }

  const processes: FunnyProcessConfig[] = [];

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([a-zA-Z0-9_-]+):\s*(.+)$/);
    if (match) {
      processes.push({
        name: match[1],
        command: match[2].trim(),
        autoRestart: true,
      });
    }
  }
  return processes;
}
