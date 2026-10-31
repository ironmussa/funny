import { Check, Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';

export function FileCopyButton({
  content,
  testId,
  stopPropagation = false,
}: {
  content: string;
  testId: string;
  stopPropagation?: boolean;
}) {
  const { t } = useTranslation();
  const [copied, copy] = useCopyToClipboard();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={(event) => {
            if (stopPropagation) event.stopPropagation();
            void copy(content);
          }}
          data-testid={testId}
          aria-label={t('tools.copy', 'Copy')}
          className="text-muted-foreground hover:text-foreground"
        >
          {copied ? (
            <Check className="icon-sm copy-feedback-icon text-green-600" />
          ) : (
            <Copy className="icon-sm copy-feedback-icon" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="left">{t('tools.copy', 'Copy')}</TooltipContent>
    </Tooltip>
  );
}
