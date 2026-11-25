import { ChevronDown } from 'lucide-react';
import { useState } from 'react';

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Textarea } from '@/components/ui/textarea';

import type { EditedPipeline, PipelinePromptField } from './use-pipeline-settings';

interface PipelineCustomPromptsProps {
  pipeline: EditedPipeline;
  handlePromptBlur: (field: PipelinePromptField, value: string) => void;
}

export function PipelineCustomPrompts({ pipeline, handlePromptBlur }: PipelineCustomPromptsProps) {
  return (
    <Collapsible>
      <div className="settings-card mb-0">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="bg-muted/30 hover:bg-muted/50 flex w-full items-center justify-between px-3 py-2 transition-colors"
          >
            <p className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
              Custom Prompts
            </p>
            <ChevronDown className="icon-sm text-muted-foreground transition-transform in-data-[state=open]:rotate-180" />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-3 p-3">
            <p className="text-muted-foreground text-xs">
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

            <PromptField
              label="Test Fixer Prompt"
              value={pipeline.testFixerPrompt ?? ''}
              onBlur={(v) => handlePromptBlur('testFixerPrompt', v)}
              placeholder="e.g. Analyze test failures and fix the underlying code..."
              testId="pipeline-test-fixer-prompt"
            />
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
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
  const [lastSeenValue, setLastSeenValue] = useState(value);

  if (value !== lastSeenValue) {
    setLastSeenValue(value);
    setLocalValue(value);
  }

  return (
    <div className="space-y-1.5">
      <label htmlFor={testId} className="text-foreground text-xs font-medium">
        {label}
      </label>
      <Textarea
        id={testId}
        value={localValue}
        onChange={(e) => setLocalValue(e.target.value)}
        onBlur={() => onBlur(localValue)}
        placeholder={placeholder}
        rows={3}
        textSize="xs"
        className="resize-y"
        data-testid={testId}
      />
    </div>
  );
}
