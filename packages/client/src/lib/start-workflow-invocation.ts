import type { TFunction } from 'i18next';

import { toast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import type { FileRef, SymbolRef } from '@/lib/thread-payload';
import { buildWorkflowRunBody, type WorkflowInvocation } from '@/lib/workflow-invocation';

/**
 * Runs the `>>workflow` the prompt named on the thread, toasting the outcome.
 * Answers whether the workflow started.
 */
export async function startWorkflowInvocation(
  threadId: string,
  invocation: WorkflowInvocation,
  refs: { fileReferences?: FileRef[]; symbolReferences?: SymbolRef[] },
  t: TFunction,
): Promise<boolean> {
  const result = await api.runWorkflow(invocation.workflowName, {
    threadId,
    ...buildWorkflowRunBody(invocation, refs),
  });
  if (result.isErr()) {
    toast.error(result.error.message);
    return false;
  }
  toast.success(t('workflows.started', { defaultValue: 'Workflow started' }));
  return true;
}
