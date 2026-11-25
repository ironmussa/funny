import type { AgentTemplate, CreateAgentTemplateRequest, DeepAgentTool } from '@funny/shared';
/**
 * Agent Template settings page — global (per-user), accessible from General Settings.
 * Templates are Deep Agent configurations selectable when creating threads.
 */
import { DEEPAGENT_TOOLS } from '@funny/shared';
import { Bot, Copy, Download, Plus, Trash2, ChevronDown, Upload, Lock, Share2 } from 'lucide-react';
import { useState, useCallback, useEffect } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  createTemplate,
  deleteTemplate,
  duplicateTemplate,
  updateTemplate,
} from '@/data/templates/actions';
import { useAgentTemplates, useTemplateUsageStats } from '@/data/templates/hooks';
import { ensureTemplatesLoaded } from '@/data/templates/loaders';
import { exportTemplate, importTemplateFile } from '@/lib/agent-template-io';
import { PROVIDER_MODELS } from '@/lib/providers';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth-store';

import { McpServersSection } from './AgentTemplateMcpServers';
import { VariablesSection } from './AgentTemplateVariables';

const PASTEL_COLORS = [
  '#7CB9E8',
  '#F4A4A4',
  '#A8D5A2',
  '#F9D98C',
  '#C3A6E0',
  '#F2A6C8',
  '#89D4CF',
  '#F9B97C',
];

const BUILTIN_SKILLS = ['code-review', 'coding-prefs', 'planning'] as const;

function isBuiltinTemplate(template: AgentTemplate): boolean {
  return template.id.startsWith('__builtin__');
}

// ── Main Component ──────────────────────────────────────────

/** `importTemplateFile` answers an error message when the file cannot be imported. */
function isImportError(result: unknown): result is string {
  return typeof result === 'string';
}

export function AgentTemplateSettings() {
  const templates = useAgentTemplates();
  const usageStats = useTemplateUsageStats();
  const currentUserId = useAuthStore((s) => s.user?.id);
  const [editingId, setEditingId] = useState<string | null>(null);

  useEffect(() => {
    void ensureTemplatesLoaded();
  }, []);

  const handleCreate = useCallback(async () => {
    const result = await createTemplate({ name: 'New Agent Template' });
    if (result.isErr()) return;
    setEditingId(result.value.id);
    toast.success('Template created');
  }, []);

  const handleImport = useCallback(async () => {
    const result = await importTemplateFile();
    if (isImportError(result)) {
      toast.error(result);
      return;
    }
    const created = await createTemplate(result);
    if (created.isErr()) return;
    setEditingId(created.value.id);
    toast.success(`Imported "${created.value.name}"`);
  }, []);

  const handleDelete = useCallback(
    async (id: string) => {
      const result = await deleteTemplate(id);
      if (result.isErr()) return;
      if (editingId === id) setEditingId(null);
      toast.success('Template deleted');
    },
    [editingId],
  );

  const handleDuplicate = useCallback(async (id: string) => {
    const result = await duplicateTemplate(id);
    if (result.isErr()) return;
    setEditingId(result.value.id);
    toast.success('Template duplicated');
  }, []);

  const ownTemplates = templates.filter((t) => !isBuiltinTemplate(t) && t.userId === currentUserId);
  const sharedTemplates = templates.filter(
    (t) => !isBuiltinTemplate(t) && t.userId !== currentUserId && t.shared,
  );
  const builtinTemplates = templates.filter((t) => isBuiltinTemplate(t));

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <p className="settings-row-desc">
            Deep Agent configurations selectable when creating threads.
          </p>
        </div>
        <div className="flex gap-1.5">
          <Button
            variant="outline"
            size="sm"
            onClick={handleImport}
            data-testid="agent-template-import"
          >
            <Upload className="icon-sm mr-1.5" />
            Import
          </Button>
          <Button size="sm" onClick={handleCreate} data-testid="agent-template-create">
            <Plus className="icon-sm mr-1.5" />
            Create
          </Button>
        </div>
      </div>

      {/* Own templates */}
      {ownTemplates.length === 0 &&
        sharedTemplates.length === 0 &&
        builtinTemplates.length === 0 && (
          <EmptyState
            fill={false}
            surface="dashed"
            icon={Bot}
            title="No agent templates yet."
            description="Create one to define a reusable Deep Agent configuration."
          />
        )}

      <div className="space-y-2">
        {ownTemplates.map((tpl) => (
          <div key={tpl.id}>
            {editingId === tpl.id ? (
              <TemplateEditor
                template={tpl}
                onClose={() => setEditingId(null)}
                onDelete={() => handleDelete(tpl.id)}
              />
            ) : (
              <TemplateCard
                template={tpl}
                threadCount={usageStats[tpl.id] ?? 0}
                onEdit={() => setEditingId(tpl.id)}
                onDelete={() => handleDelete(tpl.id)}
                onDuplicate={() => handleDuplicate(tpl.id)}
                onExport={() => exportTemplate(tpl)}
              />
            )}
          </div>
        ))}
      </div>

      {/* Shared templates from other users */}
      {sharedTemplates.length > 0 && (
        <>
          <div className="mt-6 mb-2 flex items-center gap-2">
            <Share2 className="text-muted-foreground size-3" />
            <h4 className="text-muted-foreground text-xs font-medium">Shared Templates</h4>
          </div>
          <div className="space-y-2">
            {sharedTemplates.map((tpl) => (
              <TemplateCard
                key={tpl.id}
                template={tpl}
                threadCount={usageStats[tpl.id] ?? 0}
                onEdit={() => {}}
                onDelete={() => {}}
                onDuplicate={() => handleDuplicate(tpl.id)}
                onExport={() => exportTemplate(tpl)}
                isBuiltin
              />
            ))}
          </div>
        </>
      )}

      {/* Built-in templates */}
      {builtinTemplates.length > 0 && (
        <>
          <div className="mt-6 mb-2 flex items-center gap-2">
            <Lock className="text-muted-foreground size-3" />
            <h4 className="text-muted-foreground text-xs font-medium">Built-in Templates</h4>
          </div>
          <div className="space-y-2">
            {builtinTemplates.map((tpl) => (
              <TemplateCard
                key={tpl.id}
                template={tpl}
                threadCount={usageStats[tpl.id] ?? 0}
                onEdit={() => {}}
                onDelete={() => {}}
                onDuplicate={() => handleDuplicate(tpl.id)}
                onExport={() => exportTemplate(tpl)}
                isBuiltin
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── Template Card (collapsed view) ──────────────────────────

function TemplateCard({
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
            variant="ghost-destructive"
            size="icon"
            className="size-6"
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
          className="size-3 shrink-0 rounded-full bg-[color:var(--agent-template-color)]"
          style={{ '--agent-template-color': template.color }}
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

// ── Template Editor (expanded view) ─────────────────────────

function TemplateEditor({
  template,
  onClose,
  onDelete,
}: {
  template: AgentTemplate;
  onClose: () => void;
  onDelete: () => void;
}) {
  const save = useCallback(
    async (data: Partial<CreateAgentTemplateRequest>) => {
      await updateTemplate(template.id, data);
    },
    [template.id],
  );

  return (
    <div className="bg-card rounded-md border">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h4 className="text-sm font-medium">Edit Template</h4>
        <div className="flex gap-1">
          <Button
            variant="ghost-destructive"
            size="sm"
            onClick={onDelete}
            aria-label={`Delete ${template.name}`}
            data-testid="agent-template-editor-delete"
          >
            <Trash2 className="icon-sm" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onClose}
            data-testid="agent-template-editor-close"
          >
            Close editor
          </Button>
        </div>
      </div>

      <div className="space-y-1 p-4">
        {/* ── Identity ── */}
        <IdentitySection template={template} onSave={save} />

        {/* ── Model ── */}
        <CollapsibleSection title="Model" defaultOpen={false}>
          <ModelSection template={template} onSave={save} />
        </CollapsibleSection>

        {/* ── System Prompt ── */}
        <CollapsibleSection title="System Prompt" defaultOpen={!!template.systemPrompt}>
          <SystemPromptSection template={template} onSave={save} />
        </CollapsibleSection>

        {/* ── Tools ── */}
        <CollapsibleSection title="Tools" defaultOpen={!!template.disallowedTools?.length}>
          <ToolsSection template={template} onSave={save} />
        </CollapsibleSection>

        {/* ── Skills ── */}
        <CollapsibleSection title="Skills" defaultOpen={!!template.builtinSkillsDisabled?.length}>
          <SkillsSection template={template} onSave={save} />
        </CollapsibleSection>

        {/* ── MCP Servers ── */}
        <CollapsibleSection title="MCP Servers" defaultOpen={!!template.mcpServers?.length}>
          <McpServersSection template={template} onSave={save} />
        </CollapsibleSection>

        {/* ── Variables ── */}
        <CollapsibleSection title="Variables" defaultOpen={!!template.variables?.length}>
          <VariablesSection template={template} onSave={save} />
        </CollapsibleSection>

        {/* ── Sharing ── */}
        <CollapsibleSection title="Sharing" defaultOpen={!!template.shared}>
          <SharingSection template={template} onSave={save} />
        </CollapsibleSection>
      </div>
    </div>
  );
}

// ── Collapsible Section Wrapper ─────────────────────────────

function CollapsibleSection({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Collapsible defaultOpen={defaultOpen}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="text-muted-foreground hover:bg-accent/50 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs font-medium"
        >
          <ChevronDown className="size-3 transition-transform [[data-state=closed]>&]:-rotate-90" />
          {title}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="px-2 pt-1 pb-2">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ── Identity Section ────────────────────────────────────────

function IdentitySection({
  template,
  onSave,
}: {
  template: AgentTemplate;
  onSave: (data: Partial<CreateAgentTemplateRequest>) => Promise<void>;
}) {
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <div className="flex-1">
          <label htmlFor="agent-template-name" className="text-muted-foreground mb-1 block text-xs">
            Name
          </label>
          <Input
            id="agent-template-name"
            defaultValue={template.name}
            onBlur={(e) => {
              if (e.target.value !== template.name) onSave({ name: e.target.value });
            }}
            data-testid="agent-template-name"
          />
        </div>
      </div>
      <div>
        <label
          htmlFor="agent-template-description"
          className="text-muted-foreground mb-1 block text-xs"
        >
          Description
        </label>
        <Input
          id="agent-template-description"
          defaultValue={template.description ?? ''}
          placeholder="What does this agent do?"
          onBlur={(e) => {
            const val = e.target.value || undefined;
            if (val !== (template.description ?? undefined)) onSave({ description: val });
          }}
          data-testid="agent-template-description"
        />
      </div>
      <fieldset>
        <legend className="text-muted-foreground mb-1 block text-xs">Color</legend>
        <div className="flex gap-1.5">
          {PASTEL_COLORS.map((color) => (
            <button
              key={color}
              className={cn(
                'size-5 rounded-full border-2 transition-all',
                template.color === color ? 'border-foreground scale-110' : 'border-transparent',
                'bg-[color:var(--agent-template-swatch)]',
              )}
              style={{ '--agent-template-swatch': color }}
              onClick={() => onSave({ color })}
              aria-label={`Set color ${color}`}
              aria-pressed={template.color === color}
              data-testid={`agent-template-color-${color}`}
            />
          ))}
          {template.color && (
            <button
              className="text-muted-foreground hover:text-foreground text-2xs ml-1"
              onClick={() => onSave({ color: undefined })}
            >
              clear
            </button>
          )}
        </div>
      </fieldset>
      <div>
        <label
          htmlFor="agent-template-agent-name"
          className="text-muted-foreground mb-1 block text-xs"
        >
          Agent Name
        </label>
        <Input
          id="agent-template-agent-name"
          defaultValue={template.agentName ?? ''}
          placeholder="funny-coding-assistant"
          onBlur={(e) => {
            const val = e.target.value || undefined;
            if (val !== (template.agentName ?? undefined)) onSave({ agentName: val });
          }}
          data-testid="agent-template-agent-name"
        />
      </div>
    </div>
  );
}

// ── Model Section ───────────────────────────────────────────

function ModelSection({
  template,
  onSave,
}: {
  template: AgentTemplate;
  onSave: (data: Partial<CreateAgentTemplateRequest>) => Promise<void>;
}) {
  const deepAgentModels = PROVIDER_MODELS.deepagent ?? [];

  return (
    <div>
      <span id="agent-template-model-label" className="text-muted-foreground mb-1 block text-xs">
        Default Model
      </span>
      <Select value={template.model ?? ''} onValueChange={(v) => onSave({ model: v as any })}>
        <SelectTrigger
          aria-labelledby="agent-template-model-label"
          className="w-full"
          data-testid="agent-template-model"
        >
          <SelectValue placeholder="Use project default" />
        </SelectTrigger>
        <SelectContent>
          {deepAgentModels.map((m) => (
            <SelectItem key={m.value} value={m.value}>
              {m.fallback}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-muted-foreground text-2xs mt-1">
        Provider is always Deep Agent. Model can be overridden per-thread.
      </p>
    </div>
  );
}

// ── System Prompt Section ───────────────────────────────────

function SystemPromptSection({
  template,
  onSave,
}: {
  template: AgentTemplate;
  onSave: (data: Partial<CreateAgentTemplateRequest>) => Promise<void>;
}) {
  const [promptText, setPromptText] = useState(template.systemPrompt ?? '');

  return (
    <div className="space-y-2">
      <fieldset>
        <legend className="text-muted-foreground mb-1 block text-xs">Mode</legend>
        <div className="flex gap-1">
          {(['prepend', 'replace', 'append'] as const).map((mode) => (
            <button
              key={mode}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs transition-colors',
                template.systemPromptMode === mode
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:bg-accent',
              )}
              onClick={() => onSave({ systemPromptMode: mode })}
              data-testid={`agent-template-prompt-mode-${mode}`}
            >
              {mode}
            </button>
          ))}
        </div>
        <p className="text-muted-foreground text-2xs mt-1">
          {
            // oxlint-disable-next-line anti-slop-effect/prefer-effect-match -- plain literal ternary, not an Effect tagged union
            template.systemPromptMode === 'replace'
              ? 'Replaces the default Deep Agent system prompt entirely.'
              : template.systemPromptMode === 'append'
                ? 'Added after the default system prompt.'
                : 'Added before the default system prompt.'
          }
        </p>
      </fieldset>
      <div>
        <label
          htmlFor="agent-template-system-prompt"
          className="text-muted-foreground mb-1 block text-xs"
        >
          Prompt
        </label>
        <textarea
          id="agent-template-system-prompt"
          className="bg-background placeholder:text-muted-foreground focus:ring-ring w-full rounded-md border px-3 py-2 text-xs leading-relaxed focus:ring-1 focus:outline-hidden"
          rows={6}
          value={promptText}
          onChange={(e) => setPromptText(e.target.value)}
          onBlur={() => {
            if (promptText !== (template.systemPrompt ?? '')) {
              onSave({ systemPrompt: promptText || undefined });
            }
          }}
          placeholder="Enter custom system prompt instructions..."
          data-testid="agent-template-system-prompt"
        />
      </div>
    </div>
  );
}

// ── Tools Section ───────────────────────────────────────────

function ToolsSection({
  template,
  onSave,
}: {
  template: AgentTemplate;
  onSave: (data: Partial<CreateAgentTemplateRequest>) => Promise<void>;
}) {
  const disallowed = new Set(template.disallowedTools ?? []);

  const toggleTool = (tool: DeepAgentTool) => {
    const next = new Set(disallowed);
    if (next.has(tool)) {
      next.delete(tool);
    } else {
      next.add(tool);
    }
    onSave({ disallowedTools: next.size > 0 ? [...next] : undefined });
  };

  return (
    <div>
      <p className="text-muted-foreground text-2xs mb-2">
        Uncheck tools to disable them for this agent template.
      </p>
      <div className="grid grid-cols-2 gap-1.5">
        {DEEPAGENT_TOOLS.map((tool) => (
          <label
            key={tool}
            htmlFor={`agent-template-tool-${tool}`}
            className="hover:bg-accent/50 flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs"
          >
            <Checkbox
              id={`agent-template-tool-${tool}`}
              checked={!disallowed.has(tool)}
              onCheckedChange={() => toggleTool(tool)}
              data-testid={`agent-template-tool-${tool}`}
            />
            <span className="text-compact font-mono">{tool}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

// ── Skills Section ──────────────────────────────────────────

function SkillsSection({
  template,
  onSave,
}: {
  template: AgentTemplate;
  onSave: (data: Partial<CreateAgentTemplateRequest>) => Promise<void>;
}) {
  const disabled = new Set(template.builtinSkillsDisabled ?? []);

  const toggleSkill = (skill: string) => {
    const next = new Set(disabled);
    if (next.has(skill)) {
      next.delete(skill);
    } else {
      next.add(skill);
    }
    onSave({
      builtinSkillsDisabled: next.size > 0 ? [...next] : undefined,
    });
  };

  return (
    <div>
      <p className="text-muted-foreground text-2xs mb-2">
        Toggle built-in skills for this agent template.
      </p>
      <div className="space-y-1">
        {BUILTIN_SKILLS.map((skill) => (
          <label
            key={skill}
            htmlFor={`agent-template-skill-${skill}`}
            className="hover:bg-accent/50 flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs"
          >
            <Checkbox
              id={`agent-template-skill-${skill}`}
              checked={!disabled.has(skill)}
              onCheckedChange={() => toggleSkill(skill)}
              data-testid={`agent-template-skill-${skill}`}
            />
            <span>{skill}</span>
            <span className="text-muted-foreground">(built-in)</span>
          </label>
        ))}
      </div>
    </div>
  );
}

// ── Sharing Section ────────────────────────────────────────

function SharingSection({
  template,
  onSave,
}: {
  template: AgentTemplate;
  onSave: (data: Partial<CreateAgentTemplateRequest>) => Promise<void>;
}) {
  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-medium">Share with all users</p>
          <p className="text-muted-foreground text-2xs">
            Shared templates are visible to everyone on this instance.
          </p>
        </div>
        <label htmlFor="agent-template-shared" className="flex cursor-pointer items-center gap-2">
          <Checkbox
            id="agent-template-shared"
            aria-label="Shared"
            checked={template.shared ?? false}
            onCheckedChange={(checked) => onSave({ shared: checked === true })}
            data-testid="agent-template-shared"
          />
          <Share2 className="text-muted-foreground size-3" />
        </label>
      </div>
    </div>
  );
}
