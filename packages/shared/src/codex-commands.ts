/** Commands implemented by Funny's Codex integration. Keep execution and suggestions in sync. */
export const CODEX_COMMANDS = {
  compact: 'Compact the current conversation context',
  review: 'Review changes: /review [--base branch | --commit sha | instructions]',
  init: 'Generate or update AGENTS.md for this project',
  status: 'Show the Codex session and current settings',
  diff: 'Show the working tree diff',
  mcp: 'List MCP servers and tools',
  skills: 'List available Codex skills',
  apps: 'List available apps and connectors',
  plugins: 'List available plugins',
  model: 'Choose a model: /model [model-id]',
  reasoning: 'Choose reasoning effort: /reasoning [level]',
  permissions: 'Choose permissions: /permissions [mode]',
  plan: 'Toggle plan mode',
  new: 'Start a new conversation in Funny',
  clear: 'Start a fresh conversation in Funny',
  resume: 'Find and resume a Funny conversation',
  fork: 'Fork this conversation in Funny',
  rename: 'Rename this conversation: /rename title',
  archive: 'Archive this conversation in Funny',
  copy: 'Copy the latest assistant response',
  stop: 'Stop the running turn',
  help: 'Show available Codex commands',
} as const;

export type CodexCommand = keyof typeof CODEX_COMMANDS;
export const CODEX_COMMAND_NAMES = Object.keys(CODEX_COMMANDS) as CodexCommand[];

/** These commands belong to the Codex TUI or require a dedicated integration. */
export const CODEX_UNSUPPORTED_COMMANDS = new Set([
  'theme',
  'title',
  'keymap',
  'pets',
  'pet',
  'terminal-setup',
  'quit',
  'exit',
  'logout',
  'login',
  'feedback',
  'delete',
  'experimental',
  'hooks',
  'memories',
  'personality',
  'fast',
  'goal',
  'side',
  'agent',
  'subagents',
  'ps',
  'clean',
  'approve',
  'app',
  'cloud',
  'cloud-environment',
  'local',
  'worktree',
  'project',
  'ide-context',
  'mention',
  'debug-config',
  'statusline',
]);

export function parseCodexCommand(text: string): { name: string; args: string } | null {
  const match = /^\/([a-z][\w-]*(?::[a-z][\w-]*)*)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return match ? { name: match[1], args: (match[2] ?? '').trim() } : null;
}
