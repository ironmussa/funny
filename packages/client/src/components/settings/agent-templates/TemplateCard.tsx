import type { AgentTemplate } from '@funny/shared';
import { Copy, Download, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// ── Template Card (collapsed view) ──────────────────────────

export function TemplateCard({
  template,
  threadCount,
  onEdit,
  onDelete,
  onDuplicate,
  onExport,
  isBuiltin = false,
}: {
  template: AgentTemplate;
  threadCount: number;
  onEdit: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onExport: () => void;
  isBuiltin?: boolean;
}) {
  return (
    <div
      className={cn(
        'group flex items-center gap-3 rounded-md border bg-card p-3 transition-colors',
        !isBuiltin && 'hover:bg-accent/50',
      )}
      data-testid={`agent-template-card-${template.id}`}
    >
      {isBuiltin ? (
        <TemplateCardSummary template={template} threadCount={threadCount} isBuiltin />
      ) : (
        <button
          type="button"
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left"
          onClick={onEdit}
          aria-label={`Edit ${template.name}`}
        >
          <TemplateCardSummary template={template} threadCount={threadCount} />
        </button>
      )}
      <div className="flex shrink-0 gap-1 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          onClick={onExport}
          data-testid={`agent-template-export-${template.id}`}
          aria-label={`Export ${template.name}`}
        >
          <Download className="size-3" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          onClick={onDuplicate}
          data-testid={`agent-template-duplicate-${template.id}`}
          aria-label={`Duplicate ${template.name}`}
        >
          <Copy className="size-3" />
        </Button>
        {!isBuiltin && (
          <Button
            variant="ghost"
            size="icon"
            className="text-destructive size-6"
            onClick={onDelete}
            data-testid={`agent-template-delete-${template.id}`}
            aria-label={`Delete ${template.name}`}
          >
            <Trash2 className="size-3" />
          </Button>
        )}
      </div>
    </div>
  );
}

function TemplateCardSummary({
  template,
  threadCount,
  isBuiltin = false,
}: {
  template: AgentTemplate;
  threadCount: number;
  isBuiltin?: boolean;
}) {
  return (
    <>
      {template.color && (
        <span
          className="size-3 shrink-0 rounded-full"
          style={{ backgroundColor: template.color }}
        />
      )}
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{template.name}</span>
          {isBuiltin && (
            <span className="bg-muted text-muted-foreground text-3xs shrink-0 rounded px-1.5 py-0.5 font-medium">
              Built-in
            </span>
          )}
        </span>
        {template.description && (
          <span className="text-muted-foreground block truncate text-xs">
            {template.description}
          </span>
        )}
      </span>
      <span
        className="text-muted-foreground text-2xs shrink-0"
        data-testid={`agent-template-thread-count-${template.id}`}
      >
        {threadCount} {threadCount === 1 ? 'thread' : 'threads'}
      </span>
      {template.model && (
        <span className="bg-muted text-muted-foreground text-2xs shrink-0 rounded px-1.5 py-0.5">
          {template.model}
        </span>
      )}
    </>
  );
}
