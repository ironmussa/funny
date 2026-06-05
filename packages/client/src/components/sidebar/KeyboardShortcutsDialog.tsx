import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import { useUIStore } from '@/stores/ui-store';

type Shortcut = {
  keys: string[];
  labelKey: string;
};

const SHORTCUTS: Shortcut[] = [
  { keys: ['Ctrl', 'K'], labelKey: 'shortcuts.commandPalette' },
  { keys: ['Ctrl', 'Shift', 'P'], labelKey: 'shortcuts.commandPaletteAlt' },
  { keys: ['Ctrl', 'P'], labelKey: 'shortcuts.fileSearch' },
  { keys: ['Ctrl', 'F'], labelKey: 'shortcuts.searchInThread' },
  { keys: ['Ctrl', 'Shift', 'F'], labelKey: 'shortcuts.textSearch' },
  { keys: ['Ctrl', 'Shift', 'L'], labelKey: 'shortcuts.searchAcrossThreads' },
  { keys: ['Ctrl', 'B'], labelKey: 'shortcuts.toggleSidebar' },
  { keys: ['Ctrl', ','], labelKey: 'shortcuts.projectSettings' },
  { keys: ['Alt', 'N'], labelKey: 'shortcuts.newThread' },
  { keys: ['Alt', 'S'], labelKey: 'shortcuts.newScratchThread' },
  { keys: ['Alt', ']'], labelKey: 'shortcuts.nextThread' },
  { keys: ['Alt', '['], labelKey: 'shortcuts.prevThread' },
  { keys: ['Alt', '←'], labelKey: 'shortcuts.backThread' },
  { keys: ['Alt', '→'], labelKey: 'shortcuts.forwardThread' },
  { keys: ['Ctrl', '`'], labelKey: 'shortcuts.toggleTerminal' },
  { keys: ['?'], labelKey: 'shortcuts.openShortcuts' },
];

export function KeyboardShortcutsDialog() {
  const { t } = useTranslation();
  const open = useUIStore((s) => s.keyboardShortcutsOpen);
  const setOpen = useUIStore((s) => s.setKeyboardShortcutsOpen);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent data-testid="keyboard-shortcuts-dialog">
        <DialogHeader>
          <DialogTitle>{t('shortcuts.title')}</DialogTitle>
          <DialogDescription>{t('shortcuts.description')}</DialogDescription>
        </DialogHeader>
        <ul className="divide-border flex flex-col divide-y">
          {SHORTCUTS.map((s) => (
            <li
              key={s.labelKey}
              className="flex items-center justify-between gap-4 py-2 text-sm"
              data-testid={`shortcut-row-${s.labelKey}`}
            >
              <span className="text-foreground">{t(s.labelKey)}</span>
              <KbdGroup>
                {s.keys.map((k, i) => (
                  <Fragment key={`${k}-${i}`}>
                    {i > 0 && <span className="text-muted-foreground">+</span>}
                    <Kbd>{k}</Kbd>
                  </Fragment>
                ))}
              </KbdGroup>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
