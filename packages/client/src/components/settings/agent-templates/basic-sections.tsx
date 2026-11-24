import type { SystemPromptMode } from '@funny/shared';
import { Share2 } from 'lucide-react';
import { useState } from 'react';

import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { PROVIDER_MODELS } from '@/lib/providers';
import { cn } from '@/lib/utils';

import type { TemplateSectionProps } from './types';

const PROMPT_MODE_HINTS = {
  replace: 'Replaces the default Deep Agent system prompt entirely.',
  append: 'Added after the default system prompt.',
  prepend: 'Added before the default system prompt.',
} satisfies Record<SystemPromptMode, string>;

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

// ── Identity Section ────────────────────────────────────────

export function IdentitySection({ template, onSave }: TemplateSectionProps) {
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
              )}
              style={{ backgroundColor: color }}
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

export function ModelSection({ template, onSave }: TemplateSectionProps) {
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

export function SystemPromptSection({ template, onSave }: TemplateSectionProps) {
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
          {PROMPT_MODE_HINTS[template.systemPromptMode] ?? PROMPT_MODE_HINTS.prepend}
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

// ── Sharing Section ────────────────────────────────────────

export function SharingSection({ template, onSave }: TemplateSectionProps) {
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
