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

  // JSON.stringify leaves out the fields the template does not set (undefined values).
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${template.name.replace(/[^a-zA-Z0-9_-]/g, '_')}.agent-template.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function isObject(value: unknown): value is object {
  return typeof value === 'object';
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/** The fields of an imported file that are checked before the template is handed on. */
interface TemplateFileFields {
  version?: unknown;
  template?: unknown;
}

/** Parse and validate an imported JSON file. Returns the template data or an error string. */
export function parseTemplateFromJson(json: string): CreateAgentTemplateRequest | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return 'Invalid JSON file';
  }

  if (!parsed || !isObject(parsed)) return 'Invalid template file format';

  // SAFETY: `parsed` is a non-null object, and each field read below is checked first.
  const file = parsed as TemplateFileFields;
  if (file.version !== 1) return 'Unsupported template version';
  if (!file.template || !isObject(file.template)) return 'Missing template data';

  // SAFETY: `file.template` is a non-null object; its name is checked next.
  const tpl = file.template as { name?: unknown };
  if (!tpl.name || !isString(tpl.name)) return 'Template must have a name';

  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- validated shape from parsed JSON
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
