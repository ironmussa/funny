import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function expandHomePath(path: string | undefined): string | undefined {
  const trimmed = path?.trim();
  if (!trimmed) return undefined;
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/')) return join(homedir(), trimmed.slice(2));
  return trimmed;
}

export function normalizeClaudeConfigDir(configDir?: string): string | undefined {
  const expanded = expandHomePath(configDir);
  return expanded ? resolve(expanded) : undefined;
}

export function claudeConfigJsonPath(configDir?: string): string {
  const resolvedConfigDir = normalizeClaudeConfigDir(configDir) ?? join(homedir(), '.claude');
  return `${resolvedConfigDir}.json`;
}

export function defaultClaudeConfigDir(): string {
  return join(homedir(), '.claude');
}

export function claudeProfileEnv(configDir?: string): Record<string, string> | undefined {
  const resolvedConfigDir = normalizeClaudeConfigDir(configDir);
  return resolvedConfigDir ? { CLAUDE_CONFIG_DIR: resolvedConfigDir } : undefined;
}
