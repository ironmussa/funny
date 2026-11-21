import type { AgentExecutionProfileResponse } from '@funny/shared';

import { useDataQuery } from '../hooks';
import { projectAgentProfileQuery } from './queries';

/**
 * The execution profile bound to the project; `null` when none is bound (the
 * runner's default login), `undefined` while loading or without a project.
 */
export function useProjectAgentProfile(
  projectId: string | undefined,
): AgentExecutionProfileResponse | null | undefined {
  return useDataQuery(projectAgentProfileQuery(projectId ?? '')).data?.profile;
}
