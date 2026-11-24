import { findTextSearchMatches, normalizeSearchText } from '@funny/shared/lib/text-search';
import { HardDrive, ArrowLeft, ArrowRight, Search, FolderPlus } from 'lucide-react';
import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { TooltipIconButton } from '@/components/ui/tooltip-icon-button';
import { api } from '@/lib/api';
import { whilePending } from '@/lib/while-pending';

import { DirectoryListing } from './folder-picker/DirectoryListing';
import { FolderBreadcrumbs } from './folder-picker/FolderBreadcrumbs';
import { NewFolderRow } from './folder-picker/NewFolderRow';

interface FolderPickerProps {
  onSelect: (path: string) => void;
  onClose: () => void;
}

interface DirEntry {
  name: string;
  path: string;
}

/** Split a path into breadcrumb segments with their full paths */
function buildBreadcrumbs(fullPath: string): Array<{ label: string; path: string }> {
  if (!fullPath) return [];

  // Handle Windows paths like C:\Users\foo and Unix /home/foo
  const isWindows = /^[A-Za-z]:\\/.test(fullPath);
  const sep = isWindows ? '\\' : '/';
  const parts = fullPath.split(sep).filter(Boolean);

  const crumbs: Array<{ label: string; path: string }> = [];

  if (isWindows) {
    // First part is drive letter like "C:"
    crumbs.push({ label: parts[0], path: parts[0] + '\\' });
    for (let i = 1; i < parts.length; i++) {
      crumbs.push({
        label: parts[i],
        path: parts.slice(0, i + 1).join(sep) + (i < parts.length - 1 ? '' : ''),
      });
    }
  } else {
    // Unix root
    crumbs.push({ label: '/', path: '/' });
    for (let i = 0; i < parts.length; i++) {
      crumbs.push({
        label: parts[i],
        path: '/' + parts.slice(0, i + 1).join(sep),
      });
    }
  }

  return crumbs;
}

/**
 * Back/forward history of the visited folders. `step` moves one entry and
 * answers the folder to load; the load that follows does not record itself.
 */
function useBrowseHistory() {
  const entriesRef = useRef<string[]>([]);
  const indexRef = useRef(-1);
  const isNavRef = useRef(false);
  // Mirrors the refs, so render does not read them.
  const [position, setPosition] = useState({ index: -1, length: 0 });

  const push = useCallback((path: string) => {
    if (isNavRef.current) {
      isNavRef.current = false;
      return;
    }
    // Truncate forward history
    entriesRef.current = [...entriesRef.current.slice(0, indexRef.current + 1), path];
    indexRef.current = entriesRef.current.length - 1;
    setPosition({ index: indexRef.current, length: entriesRef.current.length });
  }, []);

  const step = useCallback((delta: 1 | -1): string | null => {
    const next = indexRef.current + delta;
    if (next < 0 || next >= entriesRef.current.length) return null;
    indexRef.current = next;
    setPosition({ index: next, length: entriesRef.current.length });
    isNavRef.current = true;
    return entriesRef.current[next];
  }, []);

  return useMemo(
    () => ({
      canGoBack: position.index > 0,
      canGoForward: position.index < position.length - 1,
      push,
      step,
    }),
    [position, push, step],
  );
}

type Listing = NonNullable<Awaited<ReturnType<typeof listDirectory>>>;

/** Shows a listing: each field the response carries replaces what is shown. */
function applyListing(
  data: Listing,
  set: {
    setCurrentPath: (path: string) => void;
    setParentPath: (parent: Listing['parent']) => void;
    setDirs: (dirs: NonNullable<Listing['dirs']>) => void;
  },
): void {
  if (data.path) set.setCurrentPath(data.path);
  if (data.parent !== undefined) set.setParentPath(data.parent);
  if (data.dirs) set.setDirs(data.dirs);
}

/** Lists a directory, showing the failure as a toast; null when it could not be listed. */
async function listDirectory(path: string) {
  const result = await api.browseList(path);
  if (result.isErr()) {
    toast.error(result.error.message);
    return null;
  }
  if (result.value.error) {
    toast.error(result.value.error);
    return null;
  }
  return result.value;
}

export function FolderPicker({ onSelect, onClose }: FolderPickerProps) {
  const { t } = useTranslation();
  const [currentPath, setCurrentPath] = useState('');
  const [_parentPath, setParentPath] = useState<string | null>(null);
  const [dirs, setDirs] = useState<DirEntry[]>([]);
  const [roots, setRoots] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [newFolderError, setNewFolderError] = useState('');
  const newFolderInputRef = useRef<HTMLInputElement>(null);

  // Navigation history for back/forward
  const history = useBrowseHistory();
  const pushHistory = history.push;

  const loadDir = useCallback(
    async (path: string) => {
      setError('');
      await whilePending(setLoading, async () => {
        const data = await listDirectory(path);
        if (!data) return;
        applyListing(data, { setCurrentPath, setParentPath, setDirs });
        setSearch('');
        pushHistory(data.path);
        localStorage.setItem('funny:last-browse-path', data.path);
      });
    },
    [pushHistory],
  );

  // Load drive roots on mount, restore last path
  useEffect(() => {
    (async () => {
      const rootsResult = await api.browseRoots();
      if (rootsResult.isErr()) {
        setError(rootsResult.error.message);
        setLoading(false);
        return;
      }
      const data = rootsResult.value;
      setRoots(data.roots || []);
      const lastPath = localStorage.getItem('funny:last-browse-path');
      if (lastPath && lastPath !== data.home) {
        // Try saved path first; fall back to home on error
        const listResult = await api.browseList(lastPath);
        if (listResult.isErr() || listResult.value.error) {
          localStorage.removeItem('funny:last-browse-path');
          loadDir(data.home);
        } else {
          setCurrentPath(listResult.value.path);
          setParentPath(listResult.value.parent);
          setDirs(listResult.value.dirs);
          pushHistory(listResult.value.path);
          setLoading(false);
        }
      } else {
        loadDir(data.home);
      }
    })();
    // Both helpers keep one identity, so this still runs once, on mount.
  }, [loadDir, pushHistory]);

  const filteredDirs = useMemo(() => {
    if (!search.trim()) return dirs;
    const q = normalizeSearchText(search);
    return dirs
      .filter((d) => findTextSearchMatches(d.name, q).length > 0)
      .sort((a, b) => {
        const aLower = normalizeSearchText(a.name);
        const bLower = normalizeSearchText(b.name);
        const aStartsWith = aLower.startsWith(q) ? 0 : 1;
        const bStartsWith = bLower.startsWith(q) ? 0 : 1;
        if (aStartsWith !== bStartsWith) return aStartsWith - bStartsWith;
        return aLower.length - bLower.length || aLower.localeCompare(bLower);
      });
  }, [dirs, search]);

  const goStep = useCallback(
    (delta: 1 | -1) => {
      const path = history.step(delta);
      if (path !== null) loadDir(path);
    },
    [history, loadDir],
  );

  const handleCreateFolder = async () => {
    const name = newFolderName.trim();
    if (!name) return;
    setNewFolderError('');
    const result = await api.createDirectory(currentPath, name);
    if (result.isErr()) {
      setNewFolderError(result.error.message);
      return;
    }
    setCreatingFolder(false);
    setNewFolderName('');
    // Navigate into the newly created folder
    loadDir(result.value.path);
  };

  const cancelCreateFolder = () => {
    setCreatingFolder(false);
    setNewFolderName('');
    setNewFolderError('');
  };

  // Auto-focus the new folder input when it appears
  useEffect(() => {
    if (creatingFolder && newFolderInputRef.current) {
      newFolderInputRef.current.focus();
    }
  }, [creatingFolder]);

  const breadcrumbs = useMemo(() => buildBreadcrumbs(currentPath), [currentPath]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent flush className="flex flex-col" style={{ maxWidth: '60vw', height: '70vh' }}>
        <DialogHeader className="p-4 pb-2">
          <DialogTitle size="sm">{t('folderPicker.title')}</DialogTitle>
        </DialogHeader>

        {/* Navigation bar: back/forward + breadcrumbs */}
        <div className="border-border bg-muted/30 flex items-center gap-1 border-b px-4 py-2">
          <TooltipIconButton
            size="icon"
            onClick={() => goStep(-1)}
            disabled={!history.canGoBack}
            className="size-6 shrink-0"
            tooltip={t('folderPicker.back')}
          >
            <ArrowLeft className="icon-sm" />
          </TooltipIconButton>
          <TooltipIconButton
            size="icon"
            onClick={() => goStep(1)}
            disabled={!history.canGoForward}
            className="size-6 shrink-0"
            tooltip={t('folderPicker.forward')}
          >
            <ArrowRight className="icon-sm" />
          </TooltipIconButton>

          <FolderBreadcrumbs breadcrumbs={breadcrumbs} onNavigate={loadDir} />

          <Button
            variant="muted"
            size="xs"
            onClick={() => {
              setCreatingFolder(true);
              setNewFolderName('');
              setNewFolderError('');
            }}
            disabled={!currentPath || loading}
            className="ml-1 h-6 shrink-0"
            data-testid="folder-picker-new-folder"
          >
            <FolderPlus className="icon-xs mr-1" />
            {t('folderPicker.newFolder')}
          </Button>
        </div>

        {/* Drive roots (Windows only — empty on macOS/Linux) */}
        {roots.length > 0 && (
          <div className="border-border flex gap-1 border-b px-4 py-1.5">
            {roots.map((root) => (
              <Tooltip key={root}>
                <TooltipTrigger asChild>
                  <Button variant="muted" size="xs" onClick={() => loadDir(root)} className="h-6">
                    <HardDrive className="icon-xs mr-1" />
                    {root.replace(':\\', '')}
                  </Button>
                </TooltipTrigger>
                <TooltipContent variant="mono">{root}</TooltipContent>
              </Tooltip>
            ))}
          </div>
        )}

        {/* Search filter — stays mounted during navigation loads to avoid a layout jump */}
        {dirs.length > 0 && (
          <div className="border-border border-b px-4 py-2">
            <div className="relative">
              <Search className="icon-xs text-muted-foreground absolute top-1/2 left-2 -translate-y-1/2" />
              <Input
                size="xs"
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('folderPicker.searchPlaceholder')}
                className="pr-2 pl-7"
                autoFocus={false}
              />
            </div>
          </div>
        )}

        {/* Directory listing */}
        <div className="flex min-h-0 flex-1 flex-col p-2">
          {/* Inline new folder creation */}
          {creatingFolder && (
            <NewFolderRow
              inputRef={newFolderInputRef}
              name={newFolderName}
              onNameChange={(name) => {
                setNewFolderName(name);
                setNewFolderError('');
              }}
              onCreate={handleCreateFolder}
              onCancel={cancelCreateFolder}
            />
          )}
          {newFolderError && (
            <p className="text-status-error mb-1 px-2 text-xs">{newFolderError}</p>
          )}

          <DirectoryListing
            error={error}
            loading={loading}
            dirs={dirs}
            filteredDirs={filteredDirs}
            onOpen={loadDir}
          />
        </div>

        {/* Actions */}
        <DialogFooter className="border-border border-t p-4">
          <Button variant="outline" size="sm" onClick={onClose}>
            {t('folderPicker.cancel')}
          </Button>
          <Button size="sm" onClick={() => onSelect(currentPath)} disabled={!currentPath}>
            {t('folderPicker.selectFolder')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
