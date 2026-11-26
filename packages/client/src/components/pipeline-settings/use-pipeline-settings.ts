import type { Pipeline } from '@funny/shared';
import type { UpdatePipelineRequest } from '@funny/shared/contracts/pipelines';
import { useState, useEffect, useCallback, useRef } from 'react';

import { toast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { whilePending } from '@/lib/while-pending';

export type PipelinePromptField =
  | 'reviewerPrompt'
  | 'correctorPrompt'
  | 'precommitFixerPrompt'
  | 'commitMessagePrompt'
  | 'testFixerPrompt';

type ModelField = 'reviewModel' | 'fixModel' | 'precommitFixModel' | 'testFixModel';

/** The pipeline as edited here: the model pickers hold any model id the picker lists. */
export type EditedPipeline = Omit<Pipeline, ModelField> & Record<ModelField, string>;

/** Loads the project's pipeline and auto-saves field changes (debounced). */
export function usePipelineSettings(selectedProjectId: string | null) {
  const [pipeline, setPipeline] = useState<EditedPipeline | null>(null);
  const [loading, setLoading] = useState(true);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pendingUpdatesRef = useRef<UpdatePipelineRequest>({});
  const pipelineIdRef = useRef<string | null>(null);

  // Keep the pipeline ID ref in sync
  useEffect(() => {
    pipelineIdRef.current = pipeline?.id ?? null;
  }, [pipeline?.id]);

  const loadPipeline = useCallback(async () => {
    if (!selectedProjectId) return;
    await whilePending(setLoading, async () => {
      const result = await api.listPipelines(selectedProjectId);
      if (result.isOk()) {
        if (result.value.length > 0) {
          setPipeline(result.value[0]);
        } else {
          const createResult = await api.createPipeline({
            projectId: selectedProjectId,
            name: 'Code Review',
          });
          if (createResult.isOk()) setPipeline(createResult.value);
        }
      }
    });
  }, [selectedProjectId]);

  useEffect(() => {
    loadPipeline();
  }, [loadPipeline]);

  // Flush pending updates to the server
  const flushUpdates = useCallback(async () => {
    const id = pipelineIdRef.current;
    const updates = { ...pendingUpdatesRef.current };
    if (!id || Object.keys(updates).length === 0) return;
    pendingUpdatesRef.current = {};
    const result = await api.updatePipeline(id, updates);
    if (result.isErr()) {
      toast.error('Failed to save pipeline setting');
      loadPipeline(); // Revert on error
    }
  }, [loadPipeline]);

  // Clean up: flush pending saves on unmount
  useEffect(() => {
    return () => {
      clearTimeout(saveTimerRef.current);
      // Fire-and-forget flush of any pending updates
      const id = pipelineIdRef.current;
      const updates = { ...pendingUpdatesRef.current };
      if (id && Object.keys(updates).length > 0) {
        api.updatePipeline(id, updates);
      }
    };
  }, []);

  // Auto-save helper: accumulates updates and debounces the API call
  const saveField = useCallback(
    (updates: UpdatePipelineRequest) => {
      if (!pipelineIdRef.current) return;
      // Optimistic update
      setPipeline((prev) => (prev ? { ...prev, ...updates } : prev));
      // Accumulate updates so rapid changes to different fields aren't lost
      Object.assign(pendingUpdatesRef.current, updates);
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(flushUpdates, 400);
    },
    [flushUpdates],
  );

  // Stable per-field handlers so memo'd children don't re-render on every parent render
  const handlePrecommitFixModelChange = useCallback(
    (v: string) => saveField({ precommitFixModel: v }),
    [saveField],
  );
  const handleReviewModelChange = useCallback(
    (v: string) => saveField({ reviewModel: v }),
    [saveField],
  );
  const handleFixModelChange = useCallback((v: string) => saveField({ fixModel: v }), [saveField]);
  const handleTestFixModelChange = useCallback(
    (v: string) => saveField({ testFixModel: v }),
    [saveField],
  );

  // Save prompt on blur
  const handlePromptBlur = (field: PipelinePromptField, value: string) => {
    if (!pipeline) return;
    const currentValue = pipeline[field] ?? '';
    if (value !== currentValue) {
      saveField({ [field]: value || null });
    }
  };

  return {
    pipeline,
    loading,
    saveField,
    handlePrecommitFixModelChange,
    handleReviewModelChange,
    handleFixModelChange,
    handleTestFixModelChange,
    handlePromptBlur,
  };
}
