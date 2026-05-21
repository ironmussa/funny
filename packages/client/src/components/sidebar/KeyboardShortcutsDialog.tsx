import { useTranslation } from 'react-i18next';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
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
  { keys: ['Ctrl', 'Shift', 'F'], labelKey: 'shortcuts.searchAcrossThreads' },
  { keys: ['Ctrl', 'B'], labelKey: 'shortcuts.toggleSidebar' },
  { keys: ['Ctrl', ','], labelKey: 'shortcuts.projectSettings' },
  { keys: ['Alt', 'N'], labelKey: 'shortcuts.newThread' },
  { keys: ['Alt', 'S'], labelKey: 'shortcuts.newScratchThread' },
  { keys: ['Alt', ']'], labelKey: 'shortcuts.nextThread' },
  { keys: ['Alt', '['], labelKey: 'shortcuts.prevThread' },
  { keys: ['Ctrl', '`'], labelKey: 'shortcuts.toggleTerminal' },
  { keys: ['?'], labelKey: 'shortcuts.openShortcuts' },
];

function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-6 min-w-6 items-center justify-center rounded border border-border bg-muted px-1.5 font-mono text-xs font-medium text-foreground',
        className,
      )}
    >
      {children}
    </kbd>
  );
}

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
        <ul className="flex flex-col divide-y divide-border">
          {SHORTCUTS.map((s) => (
            <li
              key={s.labelKey}
              className="flex items-center justify-between gap-4 py-2 text-sm"
              data-testid={`shortcut-row-${s.labelKey}`}
            >
              <span className="text-foreground">{t(s.labelKey)}</span>
              <span className="flex items-center gap-1">
                {s.keys.map((k, i) => (
                  <span key={`${k}-${i}`} className="flex items-center gap-1">
                    {i > 0 && <span className="text-muted-foreground">+</span>}
                    <Kbd>{k}</Kbd>
                  </span>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
