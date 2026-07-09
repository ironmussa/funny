import type { FileRef, SymbolRef } from '@/lib/thread-payload';

export interface WorkflowInvocation {
  workflowName: string;
  prompt?: string;
  inputs?: Record<string, unknown>;
}

export type WorkflowInvocationParseResult =
  | { ok: true; invocation: WorkflowInvocation | null }
  | { ok: false; error: string };

const WORKFLOW_INVOCATION_RE = /^\s*>>\s*([a-z][a-z0-9-]*)(?:\s+([\s\S]*?))?\s*$/;

export function parseWorkflowInvocation(prompt: string): WorkflowInvocationParseResult {
  const match = WORKFLOW_INVOCATION_RE.exec(prompt);
  if (!match) return { ok: true, invocation: null };

  const workflowName = match[1];
  const tail = match[2]?.trim();
  if (!tail) return { ok: true, invocation: { workflowName } };

  if (tail.startsWith('{')) {
    try {
      const parsed = JSON.parse(tail) as unknown;
      if (!isPlainObject(parsed)) {
        return { ok: false, error: 'Workflow inputs must be a JSON object.' };
      }
      return { ok: true, invocation: { workflowName, inputs: parsed } };
    } catch {
      return { ok: false, error: 'Workflow inputs must be valid JSON.' };
    }
  }

  return { ok: true, invocation: { workflowName, prompt: tail } };
}

export function buildWorkflowRunBody(
  invocation: WorkflowInvocation,
  refs: { fileReferences?: FileRef[]; symbolReferences?: SymbolRef[] } = {},
): { prompt?: string; inputs?: Record<string, unknown> } {
  const inputs = { ...(invocation.inputs ?? {}) };
  if (refs.fileReferences?.length) inputs.fileReferences = refs.fileReferences;
  if (refs.symbolReferences?.length) inputs.symbolReferences = refs.symbolReferences;

  return {
    prompt: invocation.prompt,
    inputs: Object.keys(inputs).length > 0 ? inputs : undefined,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
