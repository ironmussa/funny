/**
 * Opens the search view (`/list`) filtered to the threads one origin started:
 * the factory queue links its runs' threads, the automation inbox its
 * automations' threads. A single project filter carries over.
 */
import { ListTree } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { buildPath } from '@/lib/url';

export function viewThreadsPath(origin: 'factory' | 'automation', projectId?: string | null) {
  const params = new URLSearchParams({ sort: 'updated', origin });
  if (projectId) params.set('project', projectId);
  return `/list?${params.toString()}`;
}

export function ViewThreadsButton({
  origin,
  projectId,
  testId,
}: {
  origin: 'factory' | 'automation';
  projectId?: string | null;
  testId: string;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="muted"
          size="xs"
          gap="snug"
          data-testid={testId}
          onClick={() => navigate(buildPath(viewThreadsPath(origin, projectId)))}
        >
          <ListTree className="icon-sm" />
          {t('allThreads.viewThreads', 'View threads')}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {t('allThreads.viewThreadsTooltip', 'Open the threads of these runs in the search view')}
      </TooltipContent>
    </Tooltip>
  );
}
