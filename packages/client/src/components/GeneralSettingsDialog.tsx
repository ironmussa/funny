import { useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { useSettingsStore, editorLabels, type Theme, type Editor } from '@/stores/settings-store';
import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Sun, Moon, Monitor } from 'lucide-react';

function getLanguageName(code: string): string {
  try {
    const name = new Intl.DisplayNames([code], { type: 'language' }).of(code);
    return name ? name.charAt(0).toUpperCase() + name.slice(1) : code;
  } catch {
    return code;
  }
}

function SettingRow({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3.5 border-b border-border/50 last:border-b-0">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}

function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string; icon?: React.ReactNode }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex rounded-md border border-border bg-muted/30 p-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={cn(
            'flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-sm transition-colors',
            value === opt.value
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {opt.icon}
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export function GeneralSettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { theme, defaultEditor, useInternalEditor, setTheme, setDefaultEditor, setUseInternalEditor } = useSettingsStore(useShallow(s => ({
    theme: s.theme,
    defaultEditor: s.defaultEditor,
    useInternalEditor: s.useInternalEditor,
    setTheme: s.setTheme,
    setDefaultEditor: s.setDefaultEditor,
    setUseInternalEditor: s.setUseInternalEditor,
  })));
  const { t, i18n } = useTranslation();

  // Local draft state — only committed to the store on Save
  const [draftEditor, setDraftEditor] = useState<Editor>(defaultEditor);
  const [draftUseInternalEditor, setDraftUseInternalEditor] = useState(useInternalEditor);
  const [draftTheme, setDraftTheme] = useState<Theme>(theme);
  const [draftLanguage, setDraftLanguage] = useState(i18n.language);

  // Reset draft state whenever the dialog opens
  useEffect(() => {
    if (open) {
      setDraftEditor(defaultEditor);
      setDraftUseInternalEditor(useInternalEditor);
      setDraftTheme(theme);
      setDraftLanguage(i18n.language);
    }
  }, [open, defaultEditor, useInternalEditor, theme, i18n.language]);

  const handleSave = useCallback(() => {
    setDefaultEditor(draftEditor);
    setUseInternalEditor(draftUseInternalEditor);
    setTheme(draftTheme);
    i18n.changeLanguage(draftLanguage);
    onOpenChange(false);
  }, [draftEditor, draftUseInternalEditor, draftTheme, draftLanguage, setDefaultEditor, setUseInternalEditor, setTheme, i18n, onOpenChange]);

  const handleCancel = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[85vh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-6 pt-6 pb-4 flex-shrink-0">
          <DialogTitle>{t('settings.title')}</DialogTitle>
        </DialogHeader>

        <div className="px-6 pb-5 space-y-5 overflow-y-auto flex-1 min-h-0">
          {/* General section */}
          <div>
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-1 pb-2">
              {t('settings.general')}
            </h3>
            <div className="rounded-lg border border-border/50 overflow-hidden">
              <SettingRow
                title={t('settings.defaultEditor')}
                description={t('settings.defaultEditorDesc')}
              >
                <Select value={draftEditor} onValueChange={(v) => setDraftEditor(v as Editor)}>
                  <SelectTrigger className="w-[140px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.entries(editorLabels) as [Editor, string][]).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingRow>

              <SettingRow
                title={t('settings.useInternalEditor')}
                description={t('settings.useInternalEditorDesc')}
              >
                <Checkbox
                  checked={draftUseInternalEditor}
                  onCheckedChange={(checked) => setDraftUseInternalEditor(!!checked)}
                />
              </SettingRow>

              <SettingRow
                title={t('settings.language')}
                description={t('settings.languageDesc')}
              >
                <Select value={draftLanguage} onValueChange={setDraftLanguage}>
                  <SelectTrigger className="w-[140px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.keys(i18n.options.resources ?? {}).map((code) => (
                      <SelectItem key={code} value={code}>
                        {getLanguageName(code)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingRow>
            </div>
          </div>

          {/* Appearance section */}
          <div>
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-1 pb-2">
              {t('settings.appearance')}
            </h3>
            <div className="rounded-lg border border-border/50 overflow-hidden">
              <SettingRow
                title={t('settings.theme')}
                description={t('settings.themeDesc')}
              >
                <SegmentedControl<Theme>
                  value={draftTheme}
                  onChange={setDraftTheme}
                  options={[
                    { value: 'light', label: t('settings.light'), icon: <Sun className="h-3 w-3" /> },
                    { value: 'dark', label: t('settings.dark'), icon: <Moon className="h-3 w-3" /> },
                    { value: 'system', label: t('settings.system'), icon: <Monitor className="h-3 w-3" /> },
                  ]}
                />
              </SettingRow>
            </div>
          </div>
        </div>

        <DialogFooter className="px-6 py-4 flex-shrink-0 border-t border-border/50">
          <Button variant="outline" onClick={handleCancel}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleSave}>
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
