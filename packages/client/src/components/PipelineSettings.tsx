import { ChevronDown } from 'lucide-react';
import { useState, memo } from 'react';

import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { LoadingState } from '@/components/ui/loading-state';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { PROVIDER_MODELS, PROVIDERS } from '@/lib/providers';
import { cn } from '@/lib/utils';
import { useProjectStore } from '@/stores/project-store';

import { PipelineCustomPrompts } from './pipeline-settings/PipelineCustomPrompts';
import { usePipelineSettings } from './pipeline-settings/use-pipeline-settings';
import { SettingAnchor, SettingRow } from './settings/SettingRow';

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
          className="border-border bg-background text-foreground hover:bg-accent hover:text-accent-foreground flex h-7 cursor-pointer items-center gap-1 rounded-md border px-2 py-1 text-xs"
        >
          <span>{currentLabel}</span>
          <ChevronDown className="icon-xs opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="end"
        className="w-auto min-w-40 p-1 data-[state=closed]:animate-none data-[state=open]:animate-none"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {PROVIDERS.map((provider) => {
          const models = PROVIDER_MODELS[provider.value] ?? [];
          return (
            <div key={provider.value}>
              <div className="text-muted-foreground px-2 py-1.5 text-xs font-semibold">
                {provider.label}
              </div>
              {models.map((m) => (
                <button
                  key={m.value}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs outline-hidden transition-colors hover:bg-accent hover:text-accent-foreground',
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
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const {
    pipeline,
    loading,
    saveField,
    handlePrecommitFixModelChange,
    handleReviewModelChange,
    handleFixModelChange,
    handleTestFixModelChange,
    handlePromptBlur,
  } = usePipelineSettings(selectedProjectId);

  if (!selectedProjectId) {
    return (
      <EmptyState padding="md" fill={false} title="Select a project to manage pipeline settings." />
    );
  }

  if (loading || !pipeline) {
    return <LoadingState label="Loading…" className="min-h-[40vh]" />;
  }

  return (
    <div className="space-y-4">
      {/* Description */}
      <div className="border-border/50 bg-muted/20 rounded-lg border px-4 py-3">
        <p className="text-muted-foreground text-sm">
          The pipeline automatically reviews and fixes your code after each commit. Every successful
          commit triggers a Reviewer agent that analyzes the diff. If issues are found, a Corrector
          agent creates fixes in an isolated worktree.
        </p>
      </div>

      {/* Pre-commit fixer section */}
      <div className="settings-card mb-0">
        <SettingAnchor
          settingId="pipelines.precommit"
          className="bg-muted/30 flex items-center justify-between px-3 py-2"
        >
          <p className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
            Pre-commit Auto-fix
          </p>
          <Switch
            checked={!!pipeline.precommitFixEnabled}
            onCheckedChange={(v) => saveField({ precommitFixEnabled: v })}
            data-testid="pipeline-precommit-toggle"
          />
        </SettingAnchor>
        {!!pipeline.precommitFixEnabled && (
          <>
            <SettingRow
              settingId={null}
              title="Fixer Model"
              description="Model for auto-fixing lint errors"
            >
              <ModelSelect
                value={(pipeline.precommitFixModel as string) || 'sonnet'}
                onChange={handlePrecommitFixModelChange}
                testId="pipeline-precommit-model"
              />
            </SettingRow>
            <SettingRow
              settingId={null}
              title="Max Fix Attempts"
              description="Max retries before failing the commit"
            >
              <Input
                size="xs"
                type="number"
                min={1}
                max={5}
                value={pipeline.precommitFixMaxIterations ?? 3}
                onChange={(e) =>
                  saveField({ precommitFixMaxIterations: parseInt(e.target.value, 10) || 3 })
                }
                className="h-8 w-16 text-center"
                data-testid="pipeline-precommit-max"
              />
            </SettingRow>
          </>
        )}
      </div>

      {/* Post-commit review section */}
      <div className="settings-card mb-0">
        <SettingAnchor
          settingId="pipelines.review"
          className="bg-muted/30 flex items-center justify-between px-3 py-2"
        >
          <p className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
            Post-commit Review
          </p>
          <Switch
            checked={!!pipeline.enabled}
            onCheckedChange={(v) => saveField({ enabled: v })}
            data-testid="pipeline-review-toggle"
          />
        </SettingAnchor>
        {!!pipeline.enabled && (
          <>
            <SettingRow
              settingId={null}
              title="Reviewer Model"
              description="Model for analyzing code (read-only)"
            >
              <ModelSelect
                value={(pipeline.reviewModel as string) || 'sonnet'}
                onChange={handleReviewModelChange}
                testId="pipeline-review-model"
              />
            </SettingRow>
            <SettingRow
              settingId={null}
              title="Corrector Model"
              description="Model for fixing issues (worktree)"
            >
              <ModelSelect
                value={(pipeline.fixModel as string) || 'sonnet'}
                onChange={handleFixModelChange}
                testId="pipeline-fix-model"
              />
            </SettingRow>
            <SettingRow
              settingId={null}
              title="Max Iterations"
              description="Max review-fix cycles before giving up"
            >
              <Input
                size="xs"
                type="number"
                min={1}
                max={20}
                value={pipeline.maxIterations ?? 10}
                onChange={(e) => saveField({ maxIterations: parseInt(e.target.value, 10) || 10 })}
                className="h-8 w-16 text-center"
                data-testid="pipeline-max-iterations"
              />
            </SettingRow>
          </>
        )}
      </div>

      {/* Test Auto-Fix section */}
      <div className="settings-card mb-0">
        <SettingAnchor
          settingId="pipelines.tests"
          className="bg-muted/30 flex items-center justify-between px-3 py-2"
        >
          <p className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
            Test Auto-Fix
          </p>
          <Switch
            checked={!!pipeline.testEnabled}
            onCheckedChange={(v) => saveField({ testEnabled: v })}
            data-testid="pipeline-test-toggle"
          />
        </SettingAnchor>
        {!!pipeline.testEnabled && (
          <>
            <SettingRow
              settingId={null}
              title="Test Command"
              description="Command to run tests (e.g. bun test)"
            >
              <Input
                size="xs"
                type="text"
                value={pipeline.testCommand ?? ''}
                onChange={(e) => saveField({ testCommand: e.target.value })}
                placeholder="bun test"
                className="h-8 w-40"
                data-testid="pipeline-test-command"
              />
            </SettingRow>
            <SettingRow
              settingId={null}
              title="Auto-fix Failures"
              description="Spawn an agent to fix failing tests"
            >
              <Switch
                checked={!!pipeline.testFixEnabled}
                onCheckedChange={(v) => saveField({ testFixEnabled: v })}
                data-testid="pipeline-test-fix-toggle"
              />
            </SettingRow>
            {!!pipeline.testFixEnabled && (
              <>
                <SettingRow
                  settingId={null}
                  title="Fixer Model"
                  description="Model for fixing test failures"
                >
                  <ModelSelect
                    value={(pipeline.testFixModel as string) || 'sonnet'}
                    onChange={handleTestFixModelChange}
                    testId="pipeline-test-fix-model"
                  />
                </SettingRow>
                <SettingRow
                  settingId={null}
                  title="Max Fix Attempts"
                  description="Max test-fix cycles before giving up"
                >
                  <Input
                    size="xs"
                    type="number"
                    min={1}
                    max={10}
                    value={pipeline.testFixMaxIterations ?? 3}
                    onChange={(e) =>
                      saveField({ testFixMaxIterations: parseInt(e.target.value, 10) || 3 })
                    }
                    className="h-8 w-16 text-center"
                    data-testid="pipeline-test-fix-max"
                  />
                </SettingRow>
              </>
            )}
          </>
        )}
      </div>

      {/* Custom Prompts section */}
      <PipelineCustomPrompts pipeline={pipeline} handlePromptBlur={handlePromptBlur} />
    </div>
  );
}
