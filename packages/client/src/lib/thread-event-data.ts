/** One hook's result in a `workflow:hooks` event. */
export interface ThreadEventHookResult {
  label: string;
  status: string;
  error?: string;
}

/**
 * The fields the timeline reads from a workflow or git thread event's `data`
 * (written by the runtime's workflow and git pipelines). Every field is
 * optional: each event type carries only its own.
 */
export interface ThreadEventMetadata {
  workflowId?: string;
  action?: string;
  title?: string;
  status?: string;
  error?: string;
  verdict?: string;
  findingsCount?: number;
  iteration?: number;
  hasChanges?: boolean;
  reviewerThreadId?: string;
  correctorThreadId?: string;
  fixerThreadId?: string;
  hookLabel?: string;
  attempt?: number;
  hooks?: ThreadEventHookResult[];
  message?: string;
  url?: string;
  paths?: string[];
  output?: string;
  sourceBranch?: string;
  targetBranch?: string;
}

/** Thread event `data` arrives either as a JSON string or an already-parsed object. */
export function parseThreadEventData(data: string | ThreadEventMetadata): ThreadEventMetadata {
  if (typeof data === 'string') {
    try {
      return JSON.parse(data);
    } catch {
      return {};
    }
  }
  return data;
}
