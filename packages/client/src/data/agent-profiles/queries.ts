import type { ProjectAgentProfileBindingResponse } from '@funny/shared';

import { agentExecutionProfilesApi } from '@/lib/api/agent-execution-profiles';

import type { DataLayer } from '../data-layer';
import { unwrapResult } from '../query-client';
import { getDataLayer } from '../runtime';

/**
 * The execution profile bound to a project for the caller (the one a new
 * thread in that project will run with). Request-shaped with no realtime
 * event: the settings page refreshes it after every profile or binding write.
 */

const BINDING_KEY = 'agent-profile-binding';
const bindingKey = (projectId: string) => [BINDING_KEY, projectId] as const;

export function projectAgentProfileQuery(projectId: string) {
  return {
    queryKey: bindingKey(projectId),
    queryFn: (): Promise<ProjectAgentProfileBindingResponse> =>
      unwrapResult(agentExecutionProfilesApi.getProjectAgentProfileBinding(projectId)),
    staleTime: 60_000,
    enabled: projectId !== '',
  };
}

/** Re-read every project's binding (a profile rename or delete touches them all). */
export function refreshProjectAgentProfiles(layer: DataLayer = getDataLayer()): void {
  if (layer.disposed) return;
  void layer.queryClient.invalidateQueries({ queryKey: [BINDING_KEY] });
}
