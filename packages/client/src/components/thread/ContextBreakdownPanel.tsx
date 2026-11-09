import type { ContextBreakdown } from '@funny/shared';
import { ChevronRight } from 'lucide-react';

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

type Category = ContextBreakdown['categories'][number];

/** Swatch per stable category id; unknown ids fall back by kind. */
const CATEGORY_COLOR: Record<string, string> = {
  messages: 'bg-blue-500',
  mcp_tools: 'bg-orange-500',
  system_tools: 'bg-teal-500',
  memory_files: 'bg-amber-500',
  skills: 'bg-violet-500',
  custom_agents: 'bg-pink-500',
  system_prompt: 'bg-muted-foreground',
  mcp_instructions: 'bg-muted-foreground',
};

function swatchClass(c: Category): string {
  if (c.kind === 'free') return 'bg-muted';
  if (c.kind === 'deferred') return 'bg-muted-foreground/40';
  if (c.kind === 'buffer') return 'bg-muted-foreground/60';
  return (c.id && CATEGORY_COLOR[c.id]) || 'bg-muted-foreground';
}

export const formatTokens = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
};

const pctOf = (tokens: number, max: number): string =>
  max > 0 ? `${((tokens / max) * 100).toFixed(1)}%` : '—';

const basename = (path: string): string => path.split(/[\\/]/).pop() || path;

interface DetailListProps {
  testId: string;
  label: string;
  count: number;
  rows: { key: string; label: string; title?: string; tokens: number }[];
}

function DetailList({ testId, label, count, rows }: DetailListProps) {
  if (rows.length === 0) return null;
  return (
    <Collapsible>
      <CollapsibleTrigger
        data-testid={testId}
        className="group hover:text-foreground flex w-full items-center gap-1 py-0.5 text-left"
      >
        <ChevronRight className="size-3 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
        <span className="flex-1">{label}</span>
        <span className="tabular-nums">{count}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="max-h-32 overflow-y-auto pl-4">
          {rows.map((r) => (
            <li key={r.key} className="flex gap-2 py-0.5" title={r.title}>
              <span className="min-w-0 flex-1 truncate">{r.label}</span>
              <span className="tabular-nums">{formatTokens(r.tokens)}</span>
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** The `/context` breakdown: stacked bar, per-category rows, MCP servers, memory files. */
export function ContextBreakdownPanel({ breakdown }: { breakdown: ContextBreakdown }) {
  const { maxTokens } = breakdown;
  const rows = breakdown.categories.filter((c) => c.tokens > 0);
  const inWindow = rows.filter((c) => c.kind !== 'deferred');
  const deferred = rows.filter((c) => c.kind === 'deferred');
  const barSegments = inWindow.filter((c) => c.kind !== 'free');

  return (
    <div data-testid="context-breakdown" className="mt-3 border-t pt-2 text-xs">
      <div className="mb-1 flex justify-between">
        <span className="font-medium">{breakdown.percentage}% used</span>
        <span className="text-muted-foreground tabular-nums">
          {formatTokens(breakdown.totalTokens)} / {formatTokens(maxTokens)}
        </span>
      </div>
      <div className="bg-muted mb-2 flex h-1.5 w-full overflow-hidden rounded-full">
        {barSegments.map((c) => (
          <div
            key={c.id ?? c.name}
            className={swatchClass(c)}
            style={{ width: maxTokens > 0 ? `${(c.tokens / maxTokens) * 100}%` : 0 }}
          />
        ))}
      </div>
      <ul className="space-y-0.5">
        {inWindow.map((c) => (
          <li key={c.id ?? c.name} className="flex items-center gap-2">
            <span className={cn('size-2 shrink-0 rounded-sm', swatchClass(c))} />
            <span className="min-w-0 flex-1 truncate">{c.name}</span>
            <span className="text-muted-foreground tabular-nums">{formatTokens(c.tokens)}</span>
            <span className="text-muted-foreground w-11 text-right tabular-nums">
              {pctOf(c.tokens, maxTokens)}
            </span>
          </li>
        ))}
        {deferred.map((c) => (
          <li key={c.id ?? c.name} className="text-muted-foreground flex items-center gap-2">
            <span className={cn('size-2 shrink-0 rounded-sm', swatchClass(c))} />
            <span className="min-w-0 flex-1 truncate">{c.name}</span>
            <span className="tabular-nums">{formatTokens(c.tokens)}</span>
            <span className="w-11 text-right">—</span>
          </li>
        ))}
      </ul>
      <div className="text-muted-foreground mt-2">
        <DetailList
          testId="context-breakdown-mcp-toggle"
          label="MCP servers"
          count={breakdown.mcpServers.reduce((n, s) => n + s.tools, 0)}
          rows={breakdown.mcpServers.map((s) => ({
            key: s.name,
            label: `${s.name} (${s.tools})`,
            tokens: s.tokens,
          }))}
        />
        <DetailList
          testId="context-breakdown-memory-toggle"
          label="Memory files"
          count={breakdown.memoryFiles.length}
          rows={breakdown.memoryFiles.map((f) => ({
            key: f.path,
            label: `${basename(f.path)} · ${f.type}`,
            title: f.path,
            tokens: f.tokens,
          }))}
        />
      </div>
      <p className="text-muted-foreground mt-1">
        As of the last turn ({new Date(breakdown.capturedAt).toLocaleTimeString()}).
      </p>
    </div>
  );
}
