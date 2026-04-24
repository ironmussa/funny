/**
 * Import / export utilities for Agent Templates.
 */

import type {
  AgentTemplate,
  AgentTemplateExportFile,
  CreateAgentTemplateRequest,
} from '@funny/shared';

/** Export a template as a downloadable JSON file. */
export function exportTemplate(template: AgentTemplate): void {
  const payload: AgentTemplateExportFile = {
    version: 1,
    template: {
      name: template.name,
      description: template.description,
      icon: template.icon,
      color: template.color,
      model: template.model,
      systemPromptMode: template.systemPromptMode,
      systemPrompt: template.systemPrompt,
      disallowedTools: template.disallowedTools,
      mcpServers: template.mcpServers,
      builtinSkillsDisabled: template.builtinSkillsDisabled,
      customSkillPaths: template.customSkillPaths,
      agentName: template.agentName,
    },
  };

  // Strip undefined values
  for (const [k, v] of Object.entries(payload.template)) {
    if (v === undefined) delete (payload.template as unknown as Record<string, unknown>)[k];
  }

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${template.name.replace(/[^a-zA-Z0-9_-]/g, '_')}.agent-template.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Parse and validate an imported JSON file. Returns the template data or an error string. */
export function parseTemplateFromJson(json: string): CreateAgentTemplateRequest | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return 'Invalid JSON file';
  }

  if (!parsed || typeof parsed !== 'object') return 'Invalid template file format';

  const file = parsed as Record<string, unknown>;
  if (file.version !== 1) return 'Unsupported template version';
  if (!file.template || typeof file.template !== 'object') return 'Missing template data';

  const tpl = file.template as Record<string, unknown>;
  if (!tpl.name || typeof tpl.name !== 'string') return 'Template must have a name';

  return tpl as unknown as CreateAgentTemplateRequest;
}

/** Trigger a file input dialog and read the selected JSON file. */
export function importTemplateFile(): Promise<CreateAgentTemplateRequest | string> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) {
        resolve('No file selected');
        return;
      }
      const text = await file.text();
      resolve(parseTemplateFromJson(text));
    };
    input.click();
  });
}
