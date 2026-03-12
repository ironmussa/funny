/**
 * @domain subdomain: Memory System (Paisley Park)
 * @domain subdomain-type: core
 * @domain type: app-service
 * @domain layer: application
 *
 * Formats recalled memory facts into markdown for system prompt injection.
 * Groups by type, includes confidence and age, enforces token budget.
 */

import type { MemoryFact } from '@funny/shared';

import type { OperatorProfile } from './types.js';

// ─── Configuration ──────────────────────────────────────

const MAX_CHARS = 8000; // ~2000 tokens at ~4 chars/token

const TYPE_LABELS: Record<string, string> = {
  decision: 'Decisions',
  bug: 'Known Issues',
  pattern: 'Patterns',
  convention: 'Conventions',
  insight: 'Insights',
  context: 'Active Context',
};

const TYPE_ORDER = ['decision', 'bug', 'pattern', 'convention', 'insight', 'context'];

// ─── Main formatter ─────────────────────────────────────

export function formatRecallContext(
  facts: MemoryFact[],
  operator?: OperatorProfile | null,
): string {
  if (facts.length === 0 && !operator) return '';

  const sections: string[] = [];

  // Group facts by type
  const grouped = new Map<string, MemoryFact[]>();
  for (const fact of facts) {
    if (!grouped.has(fact.type)) grouped.set(fact.type, []);
    grouped.get(fact.type)!.push(fact);
  }

  // Build fact sections in priority order
  if (facts.length > 0) {
    sections.push('## Project Memory (auto-retrieved)\n');

    for (const type of TYPE_ORDER) {
      const items = grouped.get(type);
      if (!items?.length) continue;

      const label = TYPE_LABELS[type] || type;
      sections.push(`**${label}:**`);

      for (const fact of items) {
        const age = formatAge(fact.ingestedAt);
        const conf = fact.confidence < 1 ? ` [confidence: ${fact.confidence.toFixed(2)}]` : '';
        const firstLine = fact.content.split('\n')[0].slice(0, 200);
        sections.push(`- ${firstLine} (${age})${conf}`);
      }

      sections.push('');
    }
  }

  // Operator section
  if (operator) {
    sections.push(
      `## Current Operator: ${operator.operator}${operator.role ? ` (${operator.role})` : ''}\n`,
    );

    if (operator.preferences?.length) {
      sections.push('**Preferences for this session:**');
      for (const pref of operator.preferences) {
        sections.push(`- ${pref}`);
      }
      sections.push('');
    }

    if (operator.expertise?.length) {
      sections.push(`**Operator expertise:** ${operator.expertise.join(', ')}`);
    }

    if (operator.notes?.length) {
      sections.push('');
      for (const note of operator.notes) {
        sections.push(`> ${note}`);
      }
    }

    sections.push('');
  }

  // Join and enforce token budget
  let output = sections.join('\n');

  if (output.length > MAX_CHARS) {
    output = truncateToLimit(output, MAX_CHARS);
  }

  // Wrap in tags
  if (output.trim().length > 0) {
    return `[PROJECT MEMORY]\n${output.trim()}\n[/PROJECT MEMORY]`;
  }

  return '';
}

// ─── Helpers ────────────────────────────────────────────

function formatAge(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime();
  const days = Math.floor(ms / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function truncateToLimit(text: string, maxChars: number): string {
  const lines = text.split('\n');
  let total = 0;
  const kept: string[] = [];

  for (const line of lines) {
    if (total + line.length + 1 > maxChars) {
      kept.push('\n_...additional facts truncated to fit context window..._');
      break;
    }
    kept.push(line);
    total += line.length + 1;
  }

  return kept.join('\n');
}
