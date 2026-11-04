import { useCallback, useEffect, useMemo, useState } from 'react';

import { useAgentTemplates } from '@/data/templates/hooks';
import { ensureTemplatesLoaded } from '@/data/templates/loaders';

interface UsePromptTemplateParams {
  defaultTemplateId?: string;
  isDeepAgent: boolean;
  isNewThread: boolean;
}

/** Agent template selection + variable values (Deep Agent only). */
export function usePromptTemplate({
  defaultTemplateId,
  isDeepAgent,
  isNewThread,
}: UsePromptTemplateParams) {
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | undefined>(
    defaultTemplateId,
  );
  const [templateVarValues, setTemplateVarValues] = useState<Record<string, string>>({});
  const templates = useAgentTemplates();
  const selectedTemplate = useMemo(
    () => (selectedTemplateId ? templates.find((t) => t.id === selectedTemplateId) : undefined),
    [selectedTemplateId, templates],
  );
  const templateVars = useMemo(() => selectedTemplate?.variables ?? [], [selectedTemplate]);

  // Load templates when provider is deepagent and creating a new thread
  useEffect(() => {
    if (isDeepAgent && isNewThread) void ensureTemplatesLoaded();
  }, [isDeepAgent, isNewThread]);

  const handleTemplateChange = useCallback((v: string | undefined) => {
    setSelectedTemplateId(v);
    setTemplateVarValues({});
  }, []);

  const setTemplateVar = useCallback((name: string, value: string) => {
    setTemplateVarValues((prev) => ({ ...prev, [name]: value }));
  }, []);

  return {
    templates,
    selectedTemplateId,
    templateVars,
    templateVarValues,
    handleTemplateChange,
    setTemplateVar,
  };
}
