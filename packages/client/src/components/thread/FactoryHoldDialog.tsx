/**
 * Put a factory run on hold: the member says why (an upstream bug, a decision
 * to wait for), and the run leaves the "needs a person" column until it is
 * released. Its issue gets the on-hold label in place of the factory's label.
 */
import { FACTORY_HOLD_REASON_MAX } from '@funny/shared/contracts/factory';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogCancelButton,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

export function FactoryHoldDialog({
  open,
  onOpenChange,
  issueNumber,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  issueNumber: number | null;
  onConfirm: (reason: string) => void;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const trimmed = reason.trim();
  const submit = () => {
    if (!trimmed) return;
    onConfirm(trimmed);
    setReason('');
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {issueNumber === null
              ? t('factory.holdTitleNoIssue', 'Put this run on hold?')
              : t('factory.holdTitle', 'Put #{{issue}} on hold?', { issue: issueNumber })}
          </DialogTitle>
          <DialogDescription>
            {t(
              'factory.holdBody',
              'The run leaves "Needs a person" and waits in "On hold" until you release it. Its issue gets the on-hold label instead of the factory label, so the factory does not take it again. Releasing it sends it back to the queue, to be triaged again.',
            )}
          </DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          value={reason}
          maxLength={FACTORY_HOLD_REASON_MAX}
          placeholder={t('factory.holdReasonPlaceholder', 'Why? e.g. blocked by an upstream bug')}
          aria-label={t('factory.holdReason', 'Reason')}
          data-testid="factory-hold-reason"
          onChange={(event) => setReason(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submit();
          }}
        />
        <DialogFooter>
          <DialogCancelButton data-testid="factory-hold-cancel">
            {t('common.cancel', 'Cancel')}
          </DialogCancelButton>
          <Button data-testid="factory-hold-confirm" disabled={!trimmed} onClick={submit}>
            {t('factory.hold', 'Put on hold')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
