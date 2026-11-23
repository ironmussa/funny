/**
 * The incident that pauses the caller's issue factory (change
 * factory-agent-roles): its repository's base branch turned red after a
 * factory merge, so no factory on it admits issues. Shows what the factory
 * found (the merge it points at and the revert it opened) and lets a member
 * close the incident, which resumes admissions; it also closes by itself when
 * the base branch is green again.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { closeFactoryIncident } from '@/data/factory/actions';
import type { FactorySettings } from '@/lib/api/factory';
import { toastError } from '@/lib/toast-error';

type Incident = NonNullable<FactorySettings['incident']>;

/** An http(s) link, or null: only links GitHub gave are shown as links. */
const safeUrl = (url: string | undefined) => (url && /^https:\/\//.test(url) ? url : null);

function IncidentFinding({ incident }: { incident: Incident }) {
  const { t } = useTranslation();
  const result = incident.result;
  if (!result) {
    return (
      <p>
        {t('factory.incident.investigating', 'The factory is looking for the merge that broke it.')}
      </p>
    );
  }
  const culprit = safeUrl(result.culpritPrUrl);
  const revert = safeUrl(result.revertPrUrl);
  if (result.decision !== 'revert' || !culprit) {
    return (
      <p data-testid="settings-factory-incident-finding">
        {t(
          'factory.incident.unknown',
          'The factory could not name the merge that broke it: {{reason}}',
          {
            reason: result.reason,
          },
        )}
      </p>
    );
  }
  return (
    <p data-testid="settings-factory-incident-finding">
      {t('factory.incident.culprit', 'It points at')}{' '}
      <a
        className="underline"
        href={culprit}
        target="_blank"
        rel="noreferrer"
        data-testid="settings-factory-incident-culprit"
      >
        {culprit.replace('https://github.com/', '')}
      </a>
      {'. '}
      {revert ? (
        <a
          className="underline"
          href={revert}
          target="_blank"
          rel="noreferrer"
          data-testid="settings-factory-incident-revert"
        >
          {t('factory.incident.revert', 'Review and merge the revert')}
        </a>
      ) : (
        t(
          'factory.incident.noRevert',
          'A revert could not be opened: fix the branch, or revert it by hand.',
        )
      )}
    </p>
  );
}

export function ProjectFactoryIncident({
  projectId,
  incident,
}: {
  projectId: string;
  incident: Incident;
}) {
  const { t } = useTranslation();
  const [closing, setClosing] = useState(false);
  const close = () => {
    setClosing(true);
    void closeFactoryIncident(projectId)
      .orTee((error) => toastError(error, 'factory'))
      .match(
        () => setClosing(false),
        () => setClosing(false),
      );
  };

  return (
    <Alert
      variant="destructive"
      className="mx-4 my-2 w-auto"
      data-testid="settings-factory-incident"
    >
      <AlertDescription className="flex flex-col gap-2">
        <p>
          {t(
            'factory.incident.title',
            'The base branch {{branch}} of {{repo}} is red after a factory merge. No new issue starts until it is green again.',
            { branch: incident.baseBranch, repo: incident.repo },
          )}
        </p>
        <IncidentFinding incident={incident} />
        <div>
          <Button
            size="xs"
            variant="outline"
            disabled={closing}
            data-testid="settings-factory-incident-close"
            onClick={close}
          >
            {t('factory.incident.close', 'Close incident and resume')}
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}
