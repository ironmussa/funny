import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { projectsApi } from '@/lib/api/projects';
import { buildPath } from '@/lib/url';
import { useProjectStore } from '@/stores/project-store';

export function MissingProjectDirectoryDialog() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const project = useProjectStore((s) =>
    s.projects.find((candidate) => candidate.id === s.selectedProjectId),
  );
  const revealNonce = useProjectStore((s) => s.revealNonce);
  const [missing, setMissing] = useState<{ id: string; path: string } | null>(null);
  const projectId = project?.id;
  const projectPath = project?.path;
  const inSettings =
    pathname.includes('/settings') || new URLSearchParams(search).get('view') === 'settings';

  useEffect(() => {
    setMissing(null);
    if (!projectId || !projectPath || inSettings) return;
    const controller = new AbortController();
    void projectsApi.listBranches(projectId, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.isOk() && result.value.directoryExists === false) {
        setMissing({ id: projectId, path: projectPath });
      }
    });
    return () => controller.abort();
  }, [projectId, projectPath, revealNonce, inSettings]);

  return (
    <AlertDialog
      open={
        !inSettings &&
        missing?.id === projectId &&
        missing?.path === projectPath &&
        missing !== null
      }
      onOpenChange={(open) => {
        if (!open) setMissing(null);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('projects.missingDirectoryTitle')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('projects.missingDirectoryDescription', { path: missing?.path })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              if (missing) navigate(buildPath(`/projects/${missing.id}/settings/general`));
            }}
          >
            {t('projects.configureDirectory')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
