import type { AgentTemplate, CreateAgentTemplateRequest, TemplateVariable } from '@funny/shared';
import { Plus, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

// ── Variables Section ──────────────────────────────────────

export function VariablesSection({
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
      <p className="text-muted-foreground text-2xs mb-2">
        Define variables that users fill in when selecting this template. Use{' '}
        <code className="bg-muted rounded px-1">{'{{VARIABLE_NAME}}'}</code> in your system prompt.
      </p>

      {variables.length > 0 && (
        <div className="mb-2 space-y-2">
          {variables.map((v, idx) => (
            // Variables are controlled positional entries; names may be blank or duplicated.
            // react-doctor-disable-next-line no-array-index-as-key
            <div
              key={idx}
              className="bg-muted/30 flex items-start gap-2 rounded border p-2"
              data-testid={`agent-template-variable-${idx}`}
            >
              <div className="flex-1 space-y-1">
                <Input
                  mono
                  size="xs"
                  id={`agent-template-variable-name-${idx}`}
                  aria-label={`Variable ${idx + 1} name`}
                  value={v.name}
                  onChange={(e) => updateVariable(idx, 'name', e.target.value)}
                  placeholder="VARIABLE_NAME"
                  data-testid={`agent-template-variable-name-${idx}`}
                />
                <Input
                  size="xs"
                  id={`agent-template-variable-description-${idx}`}
                  aria-label={`Variable ${idx + 1} description`}
                  value={v.description ?? ''}
                  onChange={(e) => updateVariable(idx, 'description', e.target.value)}
                  placeholder="Description (shown to user)"
                  data-testid={`agent-template-variable-desc-${idx}`}
                />
                <Input
                  size="xs"
                  id={`agent-template-variable-default-${idx}`}
                  aria-label={`Variable ${idx + 1} default value`}
                  value={v.defaultValue ?? ''}
                  onChange={(e) => updateVariable(idx, 'defaultValue', e.target.value)}
                  placeholder="Default value (optional)"
                  data-testid={`agent-template-variable-default-${idx}`}
                />
              </div>
              <button
                aria-label={`Delete variable ${v.name || idx + 1}`}
                onClick={() => removeVariable(idx)}
                className="text-muted-foreground hover:text-destructive mt-1 rounded p-0.5"
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
        size="xs"
        onClick={addVariable}
        data-testid="agent-template-variable-add"
      >
        <Plus className="mr-1 size-3" />
        Add Variable
      </Button>
    </div>
  );
}
