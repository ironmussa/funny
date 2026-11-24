import type { DeepAgentTool } from '@funny/shared';
import { DEEPAGENT_TOOLS } from '@funny/shared';

import { Checkbox } from '@/components/ui/checkbox';

import type { TemplateSectionProps } from './types';

const BUILTIN_SKILLS = ['code-review', 'coding-prefs', 'planning'] as const;

// ── Tools Section ───────────────────────────────────────────

export function ToolsSection({ template, onSave }: TemplateSectionProps) {
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

export function SkillsSection({ template, onSave }: TemplateSectionProps) {
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
