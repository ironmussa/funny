import { UserRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useProjectAgentProfile } from '@/data/agent-profiles/hooks';

interface Props {
  projectId?: string;
  /** Provider of the selected model: a profile only applies to its own provider. */
  provider: string;
}

/**
 * Read-only label with the execution profile bound to the project, the one the
 * next message (new thread or follow-up) will run with. Hidden when no profile is bound or it targets
 * another provider (the runner's default login applies then).
 */
export function AgentProfileIndicator({ projectId, provider }: Props) {
  const { t } = useTranslation();
  const profile = useProjectAgentProfile(projectId);
  if (!profile || profile.provider !== provider) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-testid="prompt-agent-profile"
          className="text-muted-foreground flex max-w-40 shrink-0 cursor-default items-center gap-1 px-2 py-1 text-xs"
        >
          <UserRound className="icon-xs shrink-0" />
          <span className="truncate">{profile.name}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>{t('prompt.agentProfileHint')}</TooltipContent>
    </Tooltip>
  );
}
