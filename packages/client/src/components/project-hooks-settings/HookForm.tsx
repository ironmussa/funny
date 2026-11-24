import type { HookType } from '@funny/shared';
import { HOOK_TYPES } from '@funny/shared';
import { Check, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

import { ShellEditor } from './ShellEditor';

/** The add / edit form of a hook command. `idPrefix` keeps the label ids of the two apart. */
export function HookForm({
  idPrefix,
  testId,
  hookType,
  setHookType,
  label,
  setLabel,
  command,
  setCommand,
  hookTypeLabelFn,
  onCancel,
  onSubmit,
  submitLabel,
}: {
  idPrefix: 'hooks-edit' | 'hooks-add';
  testId?: string;
  hookType: HookType;
  setHookType: (type: HookType) => void;
  label: string;
  setLabel: (label: string) => void;
  command: string;
  setCommand: (command: string) => void;
  hookTypeLabelFn: (type: string) => string;
  onCancel: () => void;
  onSubmit: () => void;
  submitLabel: string;
}) {
  const { t } = useTranslation();
  return (
    <div data-testid={testId} className="settings-form-panel">
      <div>
        <span id={`${idPrefix}-type-label`} className="settings-label">
          {t('hooks.hookType')}
        </span>
        <Select value={hookType} onValueChange={(v) => setHookType(v as HookType)}>
          <SelectTrigger
            aria-labelledby={`${idPrefix}-type-label`}
            className="text-sm"
            data-testid="hooks-type-select"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {HOOK_TYPES.map((ht) => (
              <SelectItem key={ht} value={ht} className="text-sm">
                {hookTypeLabelFn(ht)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div>
        <label htmlFor={`${idPrefix}-label`} className="settings-label">
          {t('hooks.label')}
        </label>
        <Input
          id={`${idPrefix}-label`}
          className="settings-form-input"
          placeholder={t('hooks.label')}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          data-testid="hooks-label-input"
          autoFocus
        />
      </div>
      <div>
        <span className="settings-label">{t('hooks.command')}</span>
        <ShellEditor
          ariaLabel={t('hooks.command')}
          value={command}
          onChange={setCommand}
          testId="hooks-command-input"
        />
      </div>
      <div className="flex items-center justify-end gap-2 pt-1">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          <X className="icon-sm mr-1" />
          {t('common.cancel')}
        </Button>
        <Button size="sm" onClick={onSubmit}>
          <Check className="icon-sm mr-1" />
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}
