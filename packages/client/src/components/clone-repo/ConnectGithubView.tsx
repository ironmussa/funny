import { SiGithub } from '@icons-pack/react-simple-icons';
import { Settings } from 'lucide-react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';

interface ConnectGithubViewProps {
  onConnect: () => void;
  onUseToken: () => void;
}

/** Asks the user to connect GitHub, through the device flow or a token. */
export function ConnectGithubView({ onConnect, onUseToken }: ConnectGithubViewProps) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center gap-4 py-8">
      <div className="bg-muted flex size-12 items-center justify-center rounded-full">
        <SiGithub className="icon-xl" />
      </div>
      <div className="space-y-1 text-center">
        <h3 className="font-medium">{t('github.connectGithub')}</h3>
        <p className="text-muted-foreground max-w-xs text-sm">{t('github.connectDesc')}</p>
      </div>
      <div className="flex w-full max-w-xs flex-col gap-2">
        <Button className="w-full" onClick={onConnect}>
          <SiGithub className="icon-base mr-2" />
          {t('github.connectGithub')}
        </Button>
        <div className="flex items-center gap-3">
          <div className="bg-border h-px flex-1" />
          <span className="text-muted-foreground text-xs">{t('common.or')}</span>
          <div className="bg-border h-px flex-1" />
        </div>
        <Button variant="outline" className="w-full" onClick={onUseToken}>
          <Settings className="icon-base mr-2" />
          {t('github.useToken')}
        </Button>
        <p className="text-muted-foreground text-center text-xs">
          <Trans
            i18nKey="github.useTokenHint"
            components={{
              link: (
                <a
                  href="https://github.com/settings/tokens/new"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-foreground underline"
                />
              ),
            }}
          />
        </p>
      </div>
    </div>
  );
}
