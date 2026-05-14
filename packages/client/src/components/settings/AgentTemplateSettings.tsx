/**
 * Agent Template settings page — global (per-user), accessible from General Settings.
 * Templates are Deep Agent configurations selectable when creating threads.
 */

import type {
  AgentTemplate,
  CreateAgentTemplateRequest,
  DeepAgentTool,
  McpServer,
  McpServerType,
  TemplateVariable,
} from '@funny/shared';
import { DEEPAGENT_TOOLS } from '@funny/shared';
import {
  Bot,
  Copy,
  Download,
  Plus,
  Trash2,
  ChevronDown,
  Server,
  Pencil,
  Upload,
  Lock,
  Share2,
  Variable,
} from 'lucide-react';
import { useState, useCallback, useEffect } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { exportTemplate, importTemplateFile } from '@/lib/agent-template-io';
import { PROVIDER_MODELS } from '@/lib/providers';
import { cn } from '@/lib/utils';
import { useAgentTemplateStore } from '@/stores/agent-template-store';
import { useAuthStore } from '@/stores/auth-store';

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

export function AgentTemplateSettings() {
  const {
    templates,
    usageStats,
    initialized,
    loadTemplates,
    createTemplate,
    deleteTemplate,
    duplicateTemplate,
  } = useAgentTemplateStore();
  const currentUserId = useAuthStore((s) => s.user?.id);
  const [editingId, setEditingId] = useState<string | null>(null);

  useEffect(() => {
    if (!initialized) loadTemplates();
  }, [initialized, loadTemplates]);

  const handleCreate = useCallback(async () => {
    const tpl = await createTemplate({ name: 'New Agent Template' });
    if (tpl) {
      setEditingId(tpl.id);
      toast.success('Template created');
    }
  }, [createTemplate]);

  const handleImport = useCallback(async () => {
    const result = await importTemplateFile();
    if (typeof result === 'string') {
      toast.error(result);
      return;
    }
    const tpl = await createTemplate(result);
    if (tpl) {
      setEditingId(tpl.id);
      toast.success(`Imported "${tpl.name}"`);
    }
  }, [createTemplate]);

  const handleDelete = useCallback(
    async (id: string) => {
      await deleteTemplate(id);
      if (editingId === id) setEditingId(null);
      toast.success('Template deleted');
    },
    [deleteTemplate, editingId],
  );

  const handleDuplicate = useCallback(
    async (id: string) => {
      const tpl = await duplicateTemplate(id);
      if (tpl) {
        setEditingId(tpl.id);
        toast.success('Template duplicated');
      }
    },
    [duplicateTemplate],
  );

  const ownTemplates = templates.filter((t) => !isBuiltinTemplate(t) && t.userId === currentUserId);
  const sharedTemplates = templates.filter(
    (t) => !isBuiltinTemplate(t) && t.userId !== currentUserId && t.shared,
  );
  const builtinTemplates = templates.filter((t) => isBuiltinTemplate(t));

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="settings-section-header !mb-0">Agent Templates</h3>
          <p className="settings-row-desc mt-1">
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
          <div className="rounded-md border border-dashed p-6 text-center text-muted-foreground">
            <Bot className="mx-auto mb-2 size-8 opacity-50" />
            <p>No agent templates yet.</p>
            <p className="text-xs">Create one to define a reusable Deep Agent configuration.</p>
          </div>
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
          <div className="mb-2 mt-6 flex items-center gap-2">
            <Share2 className="size-3 text-muted-foreground" />
            <h4 className="text-xs font-medium text-muted-foreground">Shared Templates</h4>
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
          <div className="mb-2 mt-6 flex items-center gap-2">
            <Lock className="size-3 text-muted-foreground" />
            <h4 className="text-xs font-medium text-muted-foreground">Built-in Templates</h4>
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
        !isBuiltin && 'cursor-pointer hover:bg-accent/50',
      )}
      onClick={isBuiltin ? undefined : onEdit}
      data-testid={`agent-template-card-${template.id}`}
    >
      {template.color && (
        <div
          className="size-3 flex-shrink-0 rounded-full"
          style={{ backgroundColor: template.color }}
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <p className="truncate text-sm font-medium">{template.name}</p>
          {isBuiltin && (
            <span className="flex-shrink-0 rounded bg-muted px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground">
              Built-in
            </span>
          )}
        </div>
        {template.description && (
          <p className="truncate text-xs text-muted-foreground">{template.description}</p>
        )}
      </div>
      <span
        className="flex-shrink-0 text-[10px] text-muted-foreground"
        data-testid={`agent-template-thread-count-${template.id}`}
      >
        {threadCount} {threadCount === 1 ? 'thread' : 'threads'}
      </span>
      {template.model && (
        <span className="flex-shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {template.model}
        </span>
      )}
      <div className="flex flex-shrink-0 gap-1 opacity-0 group-hover:opacity-100">
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          onClick={(e) => {
            e.stopPropagation();
            onExport();
          }}
          data-testid={`agent-template-export-${template.id}`}
        >
          <Download className="size-3" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          onClick={(e) => {
            e.stopPropagation();
            onDuplicate();
          }}
          data-testid={`agent-template-duplicate-${template.id}`}
        >
          <Copy className="size-3" />
        </Button>
        {!isBuiltin && (
          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-destructive"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            data-testid={`agent-template-delete-${template.id}`}
          >
            <Trash2 className="size-3" />
          </Button>
        )}
      </div>
    </div>
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
  const { updateTemplate } = useAgentTemplateStore();

  const save = useCallback(
    async (data: Partial<CreateAgentTemplateRequest>) => {
      await updateTemplate(template.id, data);
    },
    [updateTemplate, template.id],
  );

  return (
    <div className="rounded-md border bg-card">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h4 className="text-sm font-medium">Edit Template</h4>
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive"
            onClick={onDelete}
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
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent/50">
        <ChevronDown className="size-3 transition-transform [[data-state=closed]>&]:rotate-[-90deg]" />
        {title}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="px-2 pb-2 pt-1">{children}</div>
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
          <label className="mb-1 block text-xs text-muted-foreground">Name</label>
          <Input
            defaultValue={template.name}
            onBlur={(e) => {
              if (e.target.value !== template.name) onSave({ name: e.target.value });
            }}
            data-testid="agent-template-name"
          />
        </div>
      </div>
      <div>
        <label className="mb-1 block text-xs text-muted-foreground">Description</label>
        <Input
          defaultValue={template.description ?? ''}
          placeholder="What does this agent do?"
          onBlur={(e) => {
            const val = e.target.value || undefined;
            if (val !== (template.description ?? undefined)) onSave({ description: val });
          }}
          data-testid="agent-template-description"
        />
      </div>
      <div>
        <label className="mb-1 block text-xs text-muted-foreground">Color</label>
        <div className="flex gap-1.5">
          {PASTEL_COLORS.map((color) => (
            <button
              key={color}
              className={cn(
                'size-5 rounded-full border-2 transition-all',
                template.color === color ? 'border-foreground scale-110' : 'border-transparent',
              )}
              style={{ backgroundColor: color }}
              onClick={() => onSave({ color })}
              data-testid={`agent-template-color-${color}`}
            />
          ))}
          {template.color && (
            <button
              className="ml-1 text-[10px] text-muted-foreground hover:text-foreground"
              onClick={() => onSave({ color: undefined })}
            >
              clear
            </button>
          )}
        </div>
      </div>
      <div>
        <label className="mb-1 block text-xs text-muted-foreground">Agent Name</label>
        <Input
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
      <label className="mb-1 block text-xs text-muted-foreground">Default Model</label>
      <Select value={template.model ?? ''} onValueChange={(v) => onSave({ model: v as any })}>
        <SelectTrigger className="w-full" data-testid="agent-template-model">
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
      <p className="mt-1 text-[10px] text-muted-foreground">
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
      <div>
        <label className="mb-1 block text-xs text-muted-foreground">Mode</label>
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
        <p className="mt-1 text-[10px] text-muted-foreground">
          {template.systemPromptMode === 'replace'
            ? 'Replaces the default Deep Agent system prompt entirely.'
            : template.systemPromptMode === 'append'
              ? 'Added after the default system prompt.'
              : 'Added before the default system prompt.'}
        </p>
      </div>
      <div>
        <label className="mb-1 block text-xs text-muted-foreground">Prompt</label>
        <textarea
          className="w-full rounded-md border bg-background px-3 py-2 text-xs leading-relaxed placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
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
      <p className="mb-2 text-[10px] text-muted-foreground">
        Uncheck tools to disable them for this agent template.
      </p>
      <div className="grid grid-cols-2 gap-1.5">
        {DEEPAGENT_TOOLS.map((tool) => (
          <label
            key={tool}
            className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-accent/50"
          >
            <Checkbox
              checked={!disallowed.has(tool)}
              onCheckedChange={() => toggleTool(tool)}
              data-testid={`agent-template-tool-${tool}`}
            />
            <span className="font-mono text-[11px]">{tool}</span>
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
      <p className="mb-2 text-[10px] text-muted-foreground">
        Toggle built-in skills for this agent template.
      </p>
      <div className="space-y-1">
        {BUILTIN_SKILLS.map((skill) => (
          <label
            key={skill}
            className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-accent/50"
          >
            <Checkbox
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

// ── MCP Servers Section ────────────────────────────────────

function McpServersSection({
  template,
  onSave,
}: {
  template: AgentTemplate;
  onSave: (data: Partial<CreateAgentTemplateRequest>) => Promise<void>;
}) {
  const servers: McpServer[] = template.mcpServers ?? [];
  const [adding, setAdding] = useState(false);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);

  const removeServer = (idx: number) => {
    const next = servers.filter((_, i) => i !== idx);
    onSave({ mcpServers: next.length > 0 ? next : undefined });
    if (editingIdx === idx) setEditingIdx(null);
  };

  const saveServer = (server: McpServer, idx?: number) => {
    const next = [...servers];
    if (idx !== undefined && idx < next.length) {
      next[idx] = server;
    } else {
      next.push(server);
    }
    onSave({ mcpServers: next });
    setAdding(false);
    setEditingIdx(null);
  };

  return (
    <div>
      <p className="mb-2 text-[10px] text-muted-foreground">
        Configure MCP servers that will be attached to this agent at startup.
      </p>

      {servers.length > 0 && (
        <div className="mb-2 space-y-1">
          {servers.map((srv, idx) =>
            editingIdx === idx ? (
              <McpServerForm
                key={idx}
                initial={srv}
                onSave={(s) => saveServer(s, idx)}
                onCancel={() => setEditingIdx(null)}
              />
            ) : (
              <div
                key={idx}
                className="flex items-center gap-2 rounded border px-2 py-1.5 text-xs"
                data-testid={`agent-template-mcp-server-${idx}`}
              >
                <Server className="size-3 flex-shrink-0 text-muted-foreground" />
                <span className="font-medium">{srv.name}</span>
                <span className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                  {srv.type}
                </span>
                <span className="truncate text-muted-foreground">
                  {srv.type === 'stdio' ? srv.command : srv.url}
                </span>
                <div className="ml-auto flex gap-1">
                  <button
                    onClick={() => setEditingIdx(idx)}
                    className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                    data-testid={`agent-template-mcp-edit-${idx}`}
                  >
                    <Pencil className="size-3" />
                  </button>
                  <button
                    onClick={() => removeServer(idx)}
                    className="rounded p-0.5 text-muted-foreground hover:text-destructive"
                    data-testid={`agent-template-mcp-delete-${idx}`}
                  >
                    <Trash2 className="size-3" />
                  </button>
                </div>
              </div>
            ),
          )}
        </div>
      )}

      {adding ? (
        <McpServerForm onSave={(s) => saveServer(s)} onCancel={() => setAdding(false)} />
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="text-xs"
          onClick={() => setAdding(true)}
          data-testid="agent-template-mcp-add"
        >
          <Plus className="mr-1 size-3" />
          Add MCP Server
        </Button>
      )}
    </div>
  );
}

// ── MCP Server Form ────────────────────────────────────────

function McpServerForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: McpServer;
  onSave: (server: McpServer) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [type, setType] = useState<McpServerType>(initial?.type ?? 'stdio');
  const [command, setCommand] = useState(initial?.command ?? '');
  const [url, setUrl] = useState(initial?.url ?? '');
  const [argsStr, setArgsStr] = useState(() => (initial?.args ?? []).join(', '));
  const [envStr, setEnvStr] = useState(() =>
    Object.entries(initial?.env ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
  );

  const handleSave = () => {
    if (!name.trim()) return;
    const args = argsStr.split(',').flatMap((s) => {
      const trimmed = s.trim();
      return trimmed ? [trimmed] : [];
    });
    const env: Record<string, string> = {};
    envStr.split('\n').forEach((line) => {
      const eqIdx = line.indexOf('=');
      if (eqIdx > 0) {
        env[line.slice(0, eqIdx).trim()] = line.slice(eqIdx + 1).trim();
      }
    });

    const server: McpServer = {
      name: name.trim(),
      type,
      ...(type === 'stdio'
        ? { command: command.trim(), args: args.length > 0 ? args : undefined }
        : {}),
      ...(type !== 'stdio' ? { url: url.trim() } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
    };
    onSave(server);
  };

  return (
    <div className="space-y-2 rounded border bg-muted/30 p-2">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[10px] text-muted-foreground">Name</label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="server-name"
            className="h-7 text-xs"
            data-testid="agent-template-mcp-name"
          />
        </div>
        <div>
          <label className="text-[10px] text-muted-foreground">Type</label>
          <Select value={type} onValueChange={(v) => setType(v as McpServerType)}>
            <SelectTrigger className="h-7 text-xs" data-testid="agent-template-mcp-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="stdio">stdio</SelectItem>
              <SelectItem value="http">http</SelectItem>
              <SelectItem value="sse">sse</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {type === 'stdio' ? (
        <>
          <div>
            <label className="text-[10px] text-muted-foreground">Command</label>
            <Input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="npx -y @modelcontextprotocol/server-..."
              className="h-7 text-xs"
              data-testid="agent-template-mcp-command"
            />
          </div>
          <div>
            <label className="text-[10px] text-muted-foreground">
              Args <span className="text-muted-foreground">(comma-separated)</span>
            </label>
            <Input
              value={argsStr}
              onChange={(e) => setArgsStr(e.target.value)}
              placeholder="--port, 3000"
              className="h-7 text-xs"
              data-testid="agent-template-mcp-args"
            />
          </div>
        </>
      ) : (
        <div>
          <label className="text-[10px] text-muted-foreground">URL</label>
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://..."
            className="h-7 text-xs"
            data-testid="agent-template-mcp-url"
          />
        </div>
      )}

      <div>
        <label className="text-[10px] text-muted-foreground">
          Environment Variables{' '}
          <span className="text-muted-foreground">(KEY=VALUE, one per line)</span>
        </label>
        <textarea
          value={envStr}
          onChange={(e) => setEnvStr(e.target.value)}
          placeholder="API_KEY=sk-..."
          rows={2}
          className="w-full rounded-md border bg-background px-2 py-1 text-xs"
          data-testid="agent-template-mcp-env"
        />
      </div>

      <div className="flex gap-1">
        <Button
          variant="default"
          size="sm"
          className="text-xs"
          onClick={handleSave}
          disabled={!name.trim()}
          data-testid="agent-template-mcp-save"
        >
          {initial ? 'Update' : 'Add'}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="text-xs"
          onClick={onCancel}
          data-testid="agent-template-mcp-cancel"
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

// ── Variables Section ──────────────────────────────────────

function VariablesSection({
  template,
  onSave,
}: {
  template: AgentTemplate;
  onSave: (data: Partial<CreateAgentTemplateRequest>) => Promise<void>;
}) {
  const variables: TemplateVariable[] = template.variables ?? [];

  const addVariable = () => {
    const next = [...variables, { name: '', description: '', defaultValue: '' }];
    onSave({ variables: next });
  };

  const updateVariable = (idx: number, field: keyof TemplateVariable, value: string) => {
    const next = [...variables];
    next[idx] = { ...next[idx], [field]: value };
    onSave({ variables: next });
  };

  const removeVariable = (idx: number) => {
    const next = variables.filter((_, i) => i !== idx);
    onSave({ variables: next.length > 0 ? next : undefined });
  };

  return (
    <div>
      <p className="mb-2 text-[10px] text-muted-foreground">
        Define variables that users fill in when selecting this template. Use{' '}
        <code className="rounded bg-muted px-1">{'{{VARIABLE_NAME}}'}</code> in your system prompt.
      </p>

      {variables.length > 0 && (
        <div className="mb-2 space-y-2">
          {variables.map((v, idx) => (
            <div
              key={idx}
              className="flex items-start gap-2 rounded border bg-muted/30 p-2"
              data-testid={`agent-template-variable-${idx}`}
            >
              <div className="flex-1 space-y-1">
                <Input
                  value={v.name}
                  onChange={(e) => updateVariable(idx, 'name', e.target.value)}
                  placeholder="VARIABLE_NAME"
                  className="h-7 font-mono text-xs"
                  data-testid={`agent-template-variable-name-${idx}`}
                />
                <Input
                  value={v.description ?? ''}
                  onChange={(e) => updateVariable(idx, 'description', e.target.value)}
                  placeholder="Description (shown to user)"
                  className="h-7 text-xs"
                  data-testid={`agent-template-variable-desc-${idx}`}
                />
                <Input
                  value={v.defaultValue ?? ''}
                  onChange={(e) => updateVariable(idx, 'defaultValue', e.target.value)}
                  placeholder="Default value (optional)"
                  className="h-7 text-xs"
                  data-testid={`agent-template-variable-default-${idx}`}
                />
              </div>
              <button
                onClick={() => removeVariable(idx)}
                className="mt-1 rounded p-0.5 text-muted-foreground hover:text-destructive"
                data-testid={`agent-template-variable-delete-${idx}`}
              >
                <Trash2 className="size-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      <Button
        variant="outline"
        size="sm"
        className="text-xs"
        onClick={addVariable}
        data-testid="agent-template-variable-add"
      >
        <Plus className="mr-1 size-3" />
        Add Variable
      </Button>
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
          <p className="text-[10px] text-muted-foreground">
            Shared templates are visible to everyone on this instance.
          </p>
        </div>
        <label className="flex cursor-pointer items-center gap-2">
          <Checkbox
            checked={template.shared ?? false}
            onCheckedChange={(checked) => onSave({ shared: checked === true })}
            data-testid="agent-template-shared"
          />
          <Share2 className="size-3 text-muted-foreground" />
        </label>
      </div>
    </div>
  );
}
