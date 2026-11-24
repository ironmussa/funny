import { Check, Copy, ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { LoadingState } from '@/components/ui/loading-state';

interface DeviceFlowViewProps {
  userCode: string;
  verificationUri: string;
  codeCopied: boolean;
  onCopyCode: () => void;
  onCancel: () => void;
}

/** The GitHub device flow: the code to enter on GitHub, while authorization is polled. */
export function DeviceFlowView({
  userCode,
  verificationUri,
  codeCopied,
  onCopyCode,
  onCancel,
}: DeviceFlowViewProps) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center gap-5 py-8">
      <div className="space-y-1 text-center">
        <h3 className="font-medium">{t('github.deviceFlow.title')}</h3>
        <p className="text-muted-foreground text-sm">{t('github.deviceFlow.desc')}</p>
      </div>

      {/* User code display */}
      <div className="flex items-center gap-2">
        <code className="bg-muted rounded-md px-4 py-2 font-mono text-2xl font-bold tracking-widest">
          {userCode}
        </code>
        <Button variant="outline" size="sm" onClick={onCopyCode}>
          {codeCopied ? (
            <Check className="icon-base copy-feedback-icon text-status-success" />
          ) : (
            <Copy className="icon-base copy-feedback-icon" />
          )}
        </Button>
      </div>

      <div className="flex gap-2">
        <Button
          variant="outline"
          onClick={() => window.open(verificationUri, '_blank', 'noopener,noreferrer')}
        >
          <ExternalLink className="icon-base mr-2" />
          {t('github.deviceFlow.openGithub')}
        </Button>
      </div>

      <LoadingState
        fill={false}
        layout="inline"
        className="text-sm"
        testId="clone-repo-waiting-auth"
        label={t('github.deviceFlow.waitingAuth')}
      />

      <Button variant="muted" size="sm" onClick={onCancel}>
        {t('common.cancel')}
      </Button>
    </div>
  );
}
