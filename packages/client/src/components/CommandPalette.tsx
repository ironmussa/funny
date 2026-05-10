import { FolderOpen } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { settingsItems, settingsLabelKeys } from '@/components/settings/items';
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandGroup,
  CommandSeparator,
  CommandItem,
} from '@/components/ui/command';
import { createClientLogger } from '@/lib/client-logger';
import { metric } from '@/lib/telemetry';
import { buildPath } from '@/lib/url';
import { useGitStatusStore } from '@/stores/git-status-store';
import { useProjectStore } from '@/stores/project-store';
import { useUIStore } from '@/stores/ui-store';

const log = createClientLogger('command-palette');

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  if (!open) {
    return null;
  }

  return <CommandPaletteContent open={open} onOpenChange={onOpenChange} />;
}

type ProjectEntry = ReturnType<typeof useProjectStore.getState>['projects'][number];

/** Manual filter for projects + settings. cmdk would mount one DOM node per
 * project (thousands for some users) just to hide most of them; this keeps
 * the rendered set capped and ranked. Settings are filtered against both
 * the english label and the translated string for es/pt searchability. */
function useFilteredCommandItems(
  projects: ProjectEntry[],
  search: string,
  t: (key: string) => string,
) {
  const searchLower = search.toLowerCase();
  const displayProjects = useMemo(() => {
    if (!searchLower) return projects.slice(0, 50);
    const scored: Array<{ p: ProjectEntry; rank: number; pos: number }> = [];
    for (const p of projects) {
      const nameIdx = p.name.toLowerCase().indexOf(searchLower);
      const pathIdx = p.path.toLowerCase().indexOf(searchLower);
      if (nameIdx === -1 && pathIdx === -1) continue;
      const rank = nameIdx !== -1 ? 0 : 1;
      const pos = nameIdx !== -1 ? nameIdx : pathIdx;
      scored.push({ p, rank, pos });
    }
    scored.sort((a, b) => a.rank - b.rank || a.pos - b.pos);
    return scored.slice(0, 50).map((s) => s.p);
  }, [projects, searchLower]);

  const displaySettings = useMemo(() => {
    if (!searchLower) return settingsItems;
    return settingsItems.filter((item) => {
      const label = item.label.toLowerCase();
      const translated = t(settingsLabelKeys[item.id] ?? item.label).toLowerCase();
      return label.includes(searchLower) || translated.includes(searchLower);
    });
  }, [searchLower, t]);

  const hasNoResults =
    !!searchLower && displayProjects.length === 0 && displaySettings.length === 0;

  return { displayProjects, displaySettings, hasNoResults, searchLower };
}

/** Records commit→paint latency relative to `window.__paletteOpenTs`, the
 * timestamp the keyboard handler stamps when ⌘K is pressed. Sends one
 * gauge per open. */
function usePaletteOpenTiming(open: boolean, projectCount: number) {
  useEffect(() => {
    if (!open) return;
    const w = window as unknown as { __paletteOpenTs?: number };
    const t0 = w.__paletteOpenTs;
    if (t0 == null) return;
    const commitMs = performance.now() - t0;
    requestAnimationFrame(() => {
      const paintMs = performance.now() - t0;
      log.info('palette.open_timing', {
        commit_ms: Math.round(commitMs),
        paint_ms: Math.round(paintMs),
        project_count: projectCount,
        settings_count: settingsItems.length,
      });
      metric('palette.open.commit_ms', Math.round(commitMs), { type: 'gauge' });
      metric('palette.open.paint_ms', Math.round(paintMs), { type: 'gauge' });
      w.__paletteOpenTs = undefined;
    });
  }, [open, projectCount]);
}

function CommandPaletteContent({ open, onOpenChange }: CommandPaletteProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const projects = useProjectStore((s) => s.projects);
  const startNewThread = useUIStore((s) => s.startNewThread);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
  const navigatedRef = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState('');
  const { displayProjects, displaySettings, hasNoResults, searchLower } = useFilteredCommandItems(
    projects,
    search,
    t,
  );

  // cmdk uses scrollIntoView({block:"nearest"}), which leaves the first
  // matched item partially clipped under the input when filtering. Reset
  // scroll to top whenever the search changes so the top match is fully visible.
  useEffect(() => {
    listRef.current?.scrollTo({ top: 0 });
  }, [search]);

  usePaletteOpenTiming(open, projects.length);

  const handleProjectSelect = (projectId: string) => {
    navigatedRef.current = true;

    // Close the command palette immediately so the UI feels responsive
    onOpenChange(false);

    // Defer the heavy navigation and state updates to avoid blocking the Radix UI
    // close animation, which otherwise causes the palette to flash or stutter.
    setTimeout(() => {
      startNewThread(projectId);
      useGitStatusStore.getState().fetchForProject(projectId);
      navigate(buildPath(`/projects/${projectId}`));
      // Re-select with revealIntent='start' AFTER startNewThread (which calls
      // selectProject without intent and would otherwise reset it to 'nearest')
      // and AFTER navigate (route-sync skips selectProject when the ID already
      // matches, so it can't clobber the intent either).
      useProjectStore.getState().selectProject(projectId, { revealIntent: 'start' });
    }, 150);
  };

  // Prevent Radix from restoring focus to the previously-focused element
  // after a navigation action (project/settings select). Instead, manually
  // focus the prompt editor once it has been mounted by React + TipTap.
  //
  // Radix Dialog has two focus-restoration paths:
  //   1. onCloseAutoFocus — we prevent the default here
  //   2. FocusScope cleanup on unmount — runs after onCloseAutoFocus
  // A single rAF isn't enough because the FocusScope cleanup steals
  // focus back after our initial focus call. We schedule multiple
  // attempts so the last one wins after all Radix teardown is complete.
  const handleCloseAutoFocus = useCallback((e: Event) => {
    if (navigatedRef.current) {
      e.preventDefault();
      navigatedRef.current = false;

      const focusEditor = () => {
        const editor = document.querySelector<HTMLElement>('[data-testid="prompt-editor"]');
        editor?.focus();
      };

      // Immediate attempt (for fast renders)
      requestAnimationFrame(focusEditor);
      // Delayed attempt to beat FocusScope cleanup + animation teardown
      setTimeout(focusEditor, 50);
      setTimeout(focusEditor, 150);
    }
  }, []);

  const handleSettingsSelect = (itemId: string) => {
    navigatedRef.current = true;
    onOpenChange(false);

    setTimeout(() => {
      setSettingsOpen(true);
      navigate(buildPath(`/settings/${itemId}`));
    }, 150);
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      onCloseAutoFocus={handleCloseAutoFocus}
      shouldFilter={false}
    >
      <CommandInput
        data-testid="command-palette-search"
        placeholder={t('commandPalette.searchPlaceholder')}
        value={search}
        onValueChange={setSearch}
      />
      <CommandList ref={listRef}>
        {hasNoResults && (
          <div className="py-6 text-center text-sm text-muted-foreground">
            {t('commandPalette.noResults')}
          </div>
        )}
        {displayProjects.length > 0 && (
          <CommandGroup heading={t('commandPalette.projects')}>
            {displayProjects.map((project) => (
              <CommandItem
                key={project.id}
                data-testid={`command-palette-project-${project.id}`}
                value={`${project.name} ${project.path}`}
                onSelect={() => handleProjectSelect(project.id)}
              >
                <FolderOpen className="icon-base flex-shrink-0" />
                <div className="flex min-w-0 flex-col">
                  <span className="truncate">{project.name}</span>
                  <span className="truncate text-xs text-muted-foreground">{project.path}</span>
                </div>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {!searchLower && displayProjects.length === 0 && (
          <div className="px-2 py-6 text-center text-sm text-muted-foreground">
            {t('commandPalette.noProjects')}
          </div>
        )}
        {displayProjects.length > 0 && displaySettings.length > 0 && <CommandSeparator />}
        {displaySettings.length > 0 && (
          <CommandGroup heading={t('commandPalette.settings')}>
            {displaySettings.map((item) => {
              const Icon = item.icon;
              return (
                <CommandItem
                  key={item.id}
                  data-testid={`command-palette-settings-${item.id}`}
                  value={item.label}
                  onSelect={() => handleSettingsSelect(item.id)}
                >
                  <Icon className="icon-base" />
                  <span>{t(settingsLabelKeys[item.id] ?? item.label)}</span>
                </CommandItem>
              );
            })}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
