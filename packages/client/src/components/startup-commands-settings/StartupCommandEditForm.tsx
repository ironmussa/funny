import { Check, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/** The inline form that edits one startup command. */
export function StartupCommandEditForm({
  cmdId,
  label,
  setLabel,
  command,
  setCommand,
  onSave,
  onCancel,
}: {
  cmdId: string;
  label: string;
  setLabel: (label: string) => void;
  command: string;
  setCommand: (command: string) => void;
  onSave: (cmdId: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="settings-form-panel">
      <div className="grid grid-cols-4 gap-2">
        <div>
          <label htmlFor={`startup-label-${cmdId}`} className="settings-label">
            {t('startup.label')}
          </label>
          <Input
            id={`startup-label-${cmdId}`}
            placeholder={t('startup.label')}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            autoFocus
          />
        </div>
        <div className="col-span-3">
          <label htmlFor={`startup-command-${cmdId}`} className="settings-label">
            {t('startup.command')}
          </label>
          <Input
            mono
            id={`startup-command-${cmdId}`}
            placeholder={t('startup.command')}
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'Enter') onSave(cmdId);
              if (e.key === 'Escape') onCancel();
            }}
          />
        </div>
      </div>
      <div className="flex items-center justify-end gap-2 pt-1">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          <X className="icon-sm mr-1" />
          {t('common.cancel')}
        </Button>
        <Button size="sm" onClick={() => onSave(cmdId)}>
          <Check className="icon-sm mr-1" />
          {t('common.save')}
        </Button>
      </div>
    </div>
  );
}
