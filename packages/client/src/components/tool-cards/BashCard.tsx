import { ChevronRight, Terminal } from 'lucide-react';
import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

import { CommandOutput } from './CommandOutput';
import { unwrapShellCommand } from './format-utils';
import { ToolContentArea } from './MobileContentPreview';

function commandToText(command: unknown): string | null {
  if (typeof command === 'string') return unwrapShellCommand(command);
  if (command == null) return null;
  if (typeof command === 'number' || typeof command === 'boolean' || typeof command === 'bigint') {
    return String(command);
  }

  try {
    return JSON.stringify(command, null, 2) ?? String(command);
  } catch {
    return String(command);
  }
}

export function BashCard({
  parsed,
  output,
  author,
  hideLabel,
  displayTime,
}: {
  parsed: Record<string, unknown>;
  output?: string;
  author?: string;
  hideLabel?: boolean;
  displayTime?: string | null;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(author === 'shell');
  const command = useMemo(() => commandToText(parsed.command), [parsed.command]);

  return (
    <div className="border-border max-w-full overflow-hidden rounded-lg border text-sm">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        className="hover:bg-accent/30 flex w-full items-center gap-2 overflow-hidden rounded-md px-3 py-1.5 text-left text-xs"
      >
        <ChevronRight
          className={cn('icon-xs shrink-0 text-muted-foreground', expanded && 'rotate-90')}
        />
        {!hideLabel && <Terminal className="icon-xs text-muted-foreground shrink-0" />}
        {!hideLabel && (
          <span className="text-foreground shrink-0 font-mono font-medium">
            {t('tools.runCommand')}
          </span>
        )}
        {!expanded && command && (
          <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-xs">
            {command}
          </span>
        )}
        {displayTime && (
          <span className="text-muted-foreground/50 ml-auto shrink-0 text-[10px] tabular-nums">
            {displayTime}
          </span>
        )}
      </button>
      {expanded && command && (
        <ToolContentArea
          className="border-border/40 border-t"
          viewportProps={{ className: 'max-h-[50vh] scroll-fade-none' }}
        >
          <CommandOutput command={command} output={output} />
        </ToolContentArea>
      )}
    </div>
  );
}
