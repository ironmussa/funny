import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { LoadingState } from '@/components/ui/loading-state';
import { useGitHubProjectId } from '@/hooks/use-github-project-id';
import { api } from '@/lib/api';

function RemoteCheck({
  projectId,
  visible,
  children,
}: {
  projectId: string;
  visible?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const [result, setResult] = useState<{ remote: string | null; error?: string } | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    void api.projectGetRemoteUrl(projectId, controller.signal).then((response) => {
      if (controller.signal.aborted) return;
      setResult(
        response.isOk()
          ? { remote: response.value.remoteUrl }
          : { remote: null, error: response.error.message },
      );
    });
    return () => controller.abort();
  }, [projectId, attempt, visible]);

  if (!result && !visible) return null;
  if (!result)
    return <LoadingState label={t('github.checkingRemote', 'Checking project remote…')} />;
  if (result.remote) return children;
  return (
    <EmptyState
      testId="github-remote-unavailable"
      title={
        result.error
          ? t('github.remoteCheckFailed', 'Could not check the project remote')
          : t('github.noRemote', 'This project has no GitHub remote configured')
      }
      description={
        result.error ??
        t(
          'github.noRemoteDescription',
          'Configure an origin remote to view pull requests and issues.',
        )
      }
      action={
        <Button
          variant="outline"
          size="sm"
          data-testid="github-remote-check-again"
          onClick={() => {
            setResult(null);
            setAttempt((value) => value + 1);
          }}
        >
          {t('github.checkAgain', 'Check again')}
        </Button>
      }
    />
  );
}

/** Mount GitHub queries only after checking the selected project's remote. */
export function GitHubProjectGate({
  visible,
  children,
}: {
  visible?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const projectId = useGitHubProjectId();
  if (!projectId) {
    return (
      <EmptyState title={t('github.selectProject', 'Select a project to view GitHub activity')} />
    );
  }
  return (
    <RemoteCheck key={projectId} projectId={projectId} visible={visible}>
      {children}
    </RemoteCheck>
  );
}
