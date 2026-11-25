import { CODEX_COMMANDS } from '@funny/shared/codex-commands';

import type {
  PromptSlashResource,
  PromptWorkflowResource,
  SuggestionItem,
  SuggestionMenuType,
} from './types';

const SLASH_RESULTS_LIMIT = 50;
const WORKFLOW_RESULTS_LIMIT = 50;
export const WORKFLOW_SUGGESTION_MATCH_OPTIONS = {
  char: '>',
  allowSpaces: false,
  allowToIncludeChar: true,
  allowedPrefixes: [' ', '\n'],
  startOfLine: false,
};

// Human-readable blurbs for the built-in SDK slash commands. The SDK reports
// command names but no descriptions, so we annotate the well-known ones; any
// other reported command falls back to a generic label.
const BUILTIN_SLASH_DESCRIPTIONS = new Map(
  Object.entries({
    compact: 'Summarize the conversation to free up context',
    clear: 'Clear the conversation history',
    context: 'Show current context window usage',
    cost: 'Show token usage and cost for this session',
    init: 'Generate a CLAUDE.md for this project',
    review: 'Review a pull request',
    'security-review': 'Review pending changes for security vulnerabilities',
    'pr-comments': 'Get comments from a GitHub pull request',
    'add-dir': 'Add a working directory to the session',
    'output-style': 'Change the agent output style',
    agents: 'Manage available subagents',
    mcp: 'Manage MCP server connections',
    memory: 'Edit memory files',
    vim: 'Toggle vim editing mode',
  }),
);
const BUILTIN_SLASH_FALLBACK = 'Built-in command';

interface WorkflowSuggestionOptions {
  workflows: readonly PromptWorkflowResource[];
  query: string;
  limit?: number;
}

export function normalizeWorkflowQuery(query: string): string {
  return query.startsWith('>') ? query.slice(1) : query;
}

export function buildWorkflowSuggestionItems({
  workflows,
  query,
  limit = WORKFLOW_RESULTS_LIMIT,
}: WorkflowSuggestionOptions): SuggestionItem[] {
  const q = normalizeWorkflowQuery(query).trim().toLowerCase();
  const matched: SuggestionItem[] = [];
  for (const workflow of workflows) {
    if (matched.length >= limit) break;
    const haystack = `${workflow.name} ${workflow.description ?? ''}`.toLowerCase();
    if (q && !haystack.includes(q)) continue;
    matched.push({
      id: workflow.name,
      label: workflow.name,
      description:
        workflow.description ??
        (workflow.source ? `${workflow.source} workflow` : 'Project workflow'),
      type: 'workflow',
    });
  }
  return matched;
}

interface SlashSuggestionOptions {
  skills: readonly (Pick<PromptSlashResource, 'name' | 'description'> &
    Partial<Pick<PromptSlashResource, 'kind'>>)[];
  sdkCommands: readonly string[];
  query: string;
  commandProvider?: string;
  limit?: number;
}

export function buildSlashSuggestionItems({
  skills,
  sdkCommands,
  query,
  commandProvider,
  limit = SLASH_RESULTS_LIMIT,
}: SlashSuggestionOptions): SuggestionItem[] {
  const skillByName = new Map(skills.map((s) => [s.name, s.description] as const));
  const sdkCommandNames = new Set(sdkCommands);

  // Build one ordered, de-duped candidate list so the SDK's built-in commands
  // (e.g. /compact) aren't crowded past the result cap by the long skills list.
  // Order: curated built-ins -> custom commands / skills -> any other SDK-reported command.
  const ordered: { name: string; description: string; type: 'slash' | 'skill' }[] = [];
  const seen = new Set<string>();
  const add = (name: string, description: string, type: 'slash' | 'skill') => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    ordered.push({ name, description, type });
  };
  // The curated descriptions are Claude Code's wording. Other providers
  // report their own /init, /compact, /review; use a neutral label there.
  const isClaude = commandProvider === 'claude';
  const builtinDesc = (name: string): string | undefined =>
    isClaude ? BUILTIN_SLASH_DESCRIPTIONS.get(name) : undefined;

  if (commandProvider === 'codex') {
    for (const [name, description] of Object.entries(CODEX_COMMANDS))
      add(name, description, 'slash');
  }
  if (isClaude) {
    for (const [name, description] of BUILTIN_SLASH_DESCRIPTIONS) {
      if (sdkCommandNames.has(name) || skillByName.has(name)) add(name, description, 'slash');
    }
  }
  for (const s of skills) {
    const type = s.kind === 'skill' && !sdkCommandNames.has(s.name) ? 'skill' : 'slash';
    add(s.name, s.description ?? (type === 'skill' ? 'Skill' : BUILTIN_SLASH_FALLBACK), type);
  }
  for (const name of sdkCommands) {
    add(name, skillByName.get(name) ?? builtinDesc(name) ?? BUILTIN_SLASH_FALLBACK, 'slash');
  }

  return matchSlashSuggestions(ordered, query, limit);
}

function matchSlashSuggestions(
  ordered: { name: string; description: string; type: 'slash' | 'skill' }[],
  query: string,
  limit: number,
): SuggestionItem[] {
  const q = query.toLowerCase();
  const matched: SuggestionItem[] = [];
  for (let i = 0; i < ordered.length && matched.length < limit; i++) {
    const o = ordered[i];
    if (o.name.toLowerCase().includes(q)) {
      matched.push({
        id: o.name,
        label: o.name,
        description: o.description,
        type: o.type,
      });
    }
  }
  return matched;
}

export function getSuggestionLoadingLabel(type: SuggestionMenuType) {
  if (type === 'file') {
    return { key: 'prompt.loadingFiles', fallback: 'Loading files...' };
  }
  if (type === 'symbol') {
    return { key: 'prompt.loadingSymbols', fallback: 'Loading symbols...' };
  }
  if (type === 'workflow') {
    return { key: 'prompt.loadingWorkflows', fallback: 'Loading workflows...' };
  }
  return { key: 'prompt.loadingCommands', fallback: 'Loading commands...' };
}
