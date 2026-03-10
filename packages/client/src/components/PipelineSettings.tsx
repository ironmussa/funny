import type { Pipeline } from '@funny/shared';
import { ChevronDown } from 'lucide-react';
import { useState, useEffect, useCallback, useRef, memo } from 'react';
import { toast } from 'sonner';

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';
import { PROVIDER_MODELS, PROVIDERS } from '@/lib/providers';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/stores/app-store';

import { SettingRow } from './settings/SettingRow';

/** Model selector matching the PromptInput pattern — grouped by provider */
const ModelSelect = memo(function ModelSelect({
  value,
  onChange,
  testId,
}: {
  value: string;
  onChange: (value: string) => void;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);

  // Find current label
  let currentLabel = value;
  for (const models of Object.values(PROVIDER_MODELS)) {
    const found = models.find((m) => m.value === value);
    if (found) {
      currentLabel = found.fallback;
      break;
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          data-testid={testId}
          className="flex h-7 cursor-pointer items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground hover:bg-accent hover:text-accent-foreground"
        >
          <span>{currentLabel}</span>
          <ChevronDown className="h-3 w-3 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="end"
        className="w-auto min-w-[10rem] p-1 data-[state=closed]:animate-none data-[state=open]:animate-none"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {PROVIDERS.map((provider) => {
          const models = PROVIDER_MODELS[provider.value] ?? [];
          return (
            <div key={provider.value}>
              <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">
                {provider.label}
              </div>
              {models.map((m) => (
                <button
                  key={m.value}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs outline-none transition-colors hover:bg-accent hover:text-accent-foreground',
                    m.value === value && 'bg-accent text-accent-foreground',
                  )}
                  onClick={() => {
                    onChange(m.value);
                    setOpen(false);
                  }}
                  data-testid={testId ? `${testId}-${m.value}` : undefined}
                >
                  {m.fallback}
                </button>
              ))}
            </div>
          );
        })}
      </PopoverContent>
    </Popover>
  );
});

export function PipelineSettings() {
  const selectedProjectId = useAppStore((s) => s.selectedProjectId);
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [loading, setLoading] = useState(true);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const loadPipeline = useCallback(async () => {
    if (!selectedProjectId) return;
    setLoading(true);
    const result = await api.listPipelines(selectedProjectId);
    if (result.isOk()) {
      if (result.value.length > 0) {
        setPipeline(result.value[0]);
      } else {
        // Auto-create pipeline if none exists
        const createResult = await api.createPipeline({
          projectId: selectedProjectId,
          name: 'Code Review',
        });
        if (createResult.isOk()) {
          setPipeline(createResult.value);
        }
      }
    }
    setLoading(false);
  }, [selectedProjectId]);

  useEffect(() => {
    loadPipeline();
  }, [loadPipeline]);

  // Auto-save helper: debounced update
  const saveField = useCallback(
    (updates: Record<string, unknown>) => {
      if (!pipeline) return;
      // Optimistic update
      setPipeline((prev) => (prev ? { ...prev, ...updates } : prev));
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(async () => {
        const result = await api.updatePipeline(pipeline.id, updates);
        if (result.isErr()) {
          toast.error('Failed to save pipeline setting');
          loadPipeline(); // Revert on error
        }
      }, 400);
    },
    [pipeline, loadPipeline],
  );

  // Save prompt on blur
  const handlePromptBlur = (field: string, value: string) => {
    if (!pipeline) return;
    const currentValue = (pipeline as unknown as Record<string, unknown>)[field] ?? '';
    if (value !== currentValue) {
      saveField({ [field]: value || null });
    }
  };

  if (!selectedProjectId) {
    return (
      <div className="py-6 text-center text-sm text-muted-foreground">
        Select a project to manage pipeline settings.
      </div>
    );
  }

  if (loading || !pipeline) {
    return <div className="py-8 text-center text-sm text-muted-foreground">Loading...</div>;
  }

  return (
    <div className="space-y-4">
      {/* Description */}
      <div className="rounded-lg border border-border/50 bg-muted/20 px-4 py-3">
        <p className="text-sm text-muted-foreground">
          The pipeline automatically reviews and fixes your code after each commit. Every successful
          commit triggers a Reviewer agent that analyzes the diff. If issues are found, a Corrector
          agent creates fixes in an isolated worktree.
        </p>
      </div>

      {/* Pre-commit fixer section */}
      <div className="settings-card mb-0">
        <div className="flex items-center justify-between bg-muted/30 px-3 py-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Pre-commit Auto-fix
          </p>
          <Switch
            checked={!!pipeline.precommitFixEnabled}
            onCheckedChange={(v) => saveField({ precommitFixEnabled: v })}
            data-testid="pipeline-precommit-toggle"
          />
        </div>
        {!!pipeline.precommitFixEnabled && (
          <>
            <SettingRow title="Fixer Model" description="Model for auto-fixing lint errors">
              <ModelSelect
                value={(pipeline.precommitFixModel as string) || 'sonnet'}
                onChange={(v) => saveField({ precommitFixModel: v })}
                testId="pipeline-precommit-model"
              />
            </SettingRow>
            <SettingRow
              title="Max Fix Attempts"
              description="Max retries before failing the commit"
            >
              <Input
                type="number"
                min={1}
                max={5}
                value={pipeline.precommitFixMaxIterations ?? 3}
                onChange={(e) =>
                  saveField({ precommitFixMaxIterations: parseInt(e.target.value, 10) || 3 })
                }
                className="h-8 w-16 text-center text-xs"
                data-testid="pipeline-precommit-max"
              />
            </SettingRow>
          </>
        )}
      </div>

      {/* Post-commit review section */}
      <div className="settings-card mb-0">
        <div className="flex items-center justify-between bg-muted/30 px-3 py-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Post-commit Review
          </p>
          <Switch
            checked={!!pipeline.enabled}
            onCheckedChange={(v) => saveField({ enabled: v })}
            data-testid="pipeline-review-toggle"
          />
        </div>
        {!!pipeline.enabled && (
          <>
            <SettingRow title="Reviewer Model" description="Model for analyzing code (read-only)">
              <ModelSelect
                value={(pipeline.reviewModel as string) || 'sonnet'}
                onChange={(v) => saveField({ reviewModel: v })}
                testId="pipeline-review-model"
              />
            </SettingRow>
            <SettingRow title="Corrector Model" description="Model for fixing issues (worktree)">
              <ModelSelect
                value={(pipeline.fixModel as string) || 'sonnet'}
                onChange={(v) => saveField({ fixModel: v })}
                testId="pipeline-fix-model"
              />
            </SettingRow>
            <SettingRow title="Max Iterations" description="Max review-fix cycles before giving up">
              <Input
                type="number"
                min={1}
                max={20}
                value={pipeline.maxIterations ?? 10}
                onChange={(e) => saveField({ maxIterations: parseInt(e.target.value, 10) || 10 })}
                className="h-8 w-16 text-center text-xs"
                data-testid="pipeline-max-iterations"
              />
            </SettingRow>
          </>
        )}
      </div>

      {/* Custom Prompts section */}
      <Collapsible>
        <div className="settings-card mb-0">
          <CollapsibleTrigger className="flex w-full items-center justify-between bg-muted/30 px-3 py-2 hover:bg-muted/50 transition-colors">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Custom Prompts
            </p>
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground transition-transform [[data-state=open]_&]:rotate-180" />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="space-y-3 p-3">
              <p className="text-xs text-muted-foreground">
                Override default prompts for each pipeline stage. Leave empty to use built-in
                defaults.
              </p>

              <PromptField
                label="Reviewer Prompt"
                value={pipeline.reviewerPrompt ?? ''}
                onBlur={(v) => handlePromptBlur('reviewerPrompt', v)}
                placeholder="e.g. You are a code reviewer. Focus on security issues and performance..."
                testId="pipeline-reviewer-prompt"
              />

              <PromptField
                label="Corrector Prompt"
                value={pipeline.correctorPrompt ?? ''}
                onBlur={(v) => handlePromptBlur('correctorPrompt', v)}
                placeholder="e.g. You are a code corrector. Fix the issues found by the reviewer..."
                testId="pipeline-corrector-prompt"
              />

              <PromptField
                label="Pre-commit Fixer Prompt"
                value={pipeline.precommitFixerPrompt ?? ''}
                onBlur={(v) => handlePromptBlur('precommitFixerPrompt', v)}
                placeholder="e.g. Fix the issues reported by the pre-commit hook..."
                testId="pipeline-precommit-fixer-prompt"
              />

              <PromptField
                label="Commit Message Prompt"
                value={pipeline.commitMessagePrompt ?? ''}
                onBlur={(v) => handlePromptBlur('commitMessagePrompt', v)}
                placeholder="e.g. Generate a commit message following our team conventions..."
                testId="pipeline-commit-message-prompt"
              />
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>
    </div>
  );
}

function PromptField({
  label,
  value,
  onBlur,
  placeholder,
  testId,
}: {
  label: string;
  value: string;
  onBlur: (value: string) => void;
  placeholder: string;
  testId: string;
}) {
  const [localValue, setLocalValue] = useState(value);

  // Sync local state when external value changes
  useEffect(() => {
    setLocalValue(value);
  }, [value]);

  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-foreground">{label}</label>
      <Textarea
        value={localValue}
        onChange={(e) => setLocalValue(e.target.value)}
        onBlur={() => onBlur(localValue)}
        placeholder={placeholder}
        rows={3}
        className="resize-y text-xs"
        data-testid={testId}
      />
    </div>
  );
}
