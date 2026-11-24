import type { AgentTemplate } from '@funny/shared';
/**
 * Agent Template settings page — global (per-user), accessible from General Settings.
 * Templates are Deep Agent configurations selectable when creating threads.
 */
import { Bot, Plus, Upload, Lock, Share2 } from 'lucide-react';
import { useState, useCallback, useEffect } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { createTemplate, deleteTemplate, duplicateTemplate } from '@/data/templates/actions';
import { useAgentTemplates, useTemplateUsageStats } from '@/data/templates/hooks';
import { ensureTemplatesLoaded } from '@/data/templates/loaders';
import { exportTemplate, importTemplateFile } from '@/lib/agent-template-io';
import { useAuthStore } from '@/stores/auth-store';

import { TemplateCard } from './agent-templates/TemplateCard';
import { TemplateEditor } from './agent-templates/TemplateEditor';

function isBuiltinTemplate(template: AgentTemplate): boolean {
  return template.id.startsWith('__builtin__');
}

// ── Main Component ──────────────────────────────────────────

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
    if (typeof result === 'string') {
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
            className="rounded-md border border-dashed p-6"
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
