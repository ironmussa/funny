import type { AgentTemplate, CreateAgentTemplateRequest } from '@funny/shared';
import { ChevronDown, Trash2 } from 'lucide-react';
import { useCallback } from 'react';

import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { updateTemplate } from '@/data/templates/actions';

import {
  IdentitySection,
  ModelSection,
  SharingSection,
  SystemPromptSection,
} from './basic-sections';
import { McpServersSection } from './McpServersSection';
import { SkillsSection, ToolsSection } from './toggle-sections';
import { VariablesSection } from './VariablesSection';

// ── Template Editor (expanded view) ─────────────────────────

export function TemplateEditor({
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
            variant="ghost"
            size="sm"
            className="text-destructive"
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
      <CollapsibleTrigger className="text-muted-foreground hover:bg-accent/50 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs font-medium">
        <ChevronDown className="size-3 transition-transform [[data-state=closed]>&]:-rotate-90" />
        {title}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="px-2 pt-1 pb-2">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}
