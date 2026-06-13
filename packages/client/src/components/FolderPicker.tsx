import {
  Folder,
  ChevronRight,
  HardDrive,
  ArrowLeft,
  ArrowRight,
  Search,
  FolderPlus,
  Check,
  X,
} from 'lucide-react';
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
import { ScrollArea } from '@/components/ui/scroll-area';
import { TooltipIconButton } from '@/components/ui/tooltip-icon-button';
import { api } from '@/lib/api';

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
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef(-1);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const isNavRef = useRef(false); // flag to skip pushing to history during back/forward

  const canGoBack = historyIndex > 0;
  const canGoForward = historyIndex < historyRef.current.length - 1;

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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only: loadDir and pushHistory are stable helpers called once on init
  }, []);

  const filteredDirs = useMemo(() => {
    if (!search.trim()) return dirs;
    const q = search.toLowerCase();
    return dirs
      .filter((d) => d.name.toLowerCase().includes(q))
      .sort((a, b) => {
        const aLower = a.name.toLowerCase();
        const bLower = b.name.toLowerCase();
        const aStartsWith = aLower.startsWith(q) ? 0 : 1;
        const bStartsWith = bLower.startsWith(q) ? 0 : 1;
        if (aStartsWith !== bStartsWith) return aStartsWith - bStartsWith;
        return aLower.length - bLower.length || aLower.localeCompare(bLower);
      });
  }, [dirs, search]);

  const pushHistory = useCallback((path: string) => {
    if (isNavRef.current) {
      isNavRef.current = false;
      return;
    }
    const idx = historyIndexRef.current;
    // Truncate forward history
    historyRef.current = historyRef.current.slice(0, idx + 1);
    historyRef.current.push(path);
    historyIndexRef.current = historyRef.current.length - 1;
    setHistoryIndex(historyIndexRef.current);
  }, []);

  const loadDir = async (path: string) => {
    setLoading(true);
    setError('');
    const result = await api.browseList(path);
    // Navigation failure (e.g. permission denied) is a no-op on the view: stay
    // on the directory we were already in — keep its listing, breadcrumb, and
    // search intact — and surface the error transiently instead of leaving a
    // stale banner sitting over the previous directory's contents.
    if (result.isErr()) {
      setLoading(false);
      toast.error(result.error.message);
      return;
    }
    const data = result.value;
    if (data.error) {
      setLoading(false);
      toast.error(data.error);
      return;
    }
    if (data.path) setCurrentPath(data.path);
    if (data.parent !== undefined) setParentPath(data.parent);
    if (data.dirs) setDirs(data.dirs);
    setSearch('');
    pushHistory(data.path);
    localStorage.setItem('funny:last-browse-path', data.path);
    setLoading(false);
  };

  const goBack = useCallback(() => {
    if (historyIndexRef.current <= 0) return;
    historyIndexRef.current--;
    setHistoryIndex(historyIndexRef.current);
    isNavRef.current = true;
    loadDir(historyRef.current[historyIndexRef.current]);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadDir is a stable local function; adding it would cause infinite re-renders
  }, []);

  const goForward = useCallback(() => {
    if (historyIndexRef.current >= historyRef.current.length - 1) return;
    historyIndexRef.current++;
    setHistoryIndex(historyIndexRef.current);
    isNavRef.current = true;
    loadDir(historyRef.current[historyIndexRef.current]);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadDir is a stable local function; adding it would cause infinite re-renders
  }, []);

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
      <DialogContent
        className="flex flex-col gap-0 p-0"
        style={{ maxWidth: '60vw', height: '70vh' }}
      >
        <DialogHeader className="p-4 pb-2">
          <DialogTitle className="text-sm">{t('folderPicker.title')}</DialogTitle>
        </DialogHeader>

        {/* Navigation bar: back/forward + breadcrumbs */}
        <div className="border-border bg-muted/30 flex items-center gap-1 border-b px-4 py-2">
          <TooltipIconButton
            size="icon"
            onClick={goBack}
            disabled={!canGoBack}
            className="size-6 shrink-0"
            tooltip={t('folderPicker.back')}
          >
            <ArrowLeft className="icon-sm" />
          </TooltipIconButton>
          <TooltipIconButton
            size="icon"
            onClick={goForward}
            disabled={!canGoForward}
            className="size-6 shrink-0"
            tooltip={t('folderPicker.forward')}
          >
            <ArrowRight className="icon-sm" />
          </TooltipIconButton>

          {/* Breadcrumb path */}
          <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
            {breadcrumbs.length === 0 && (
              <span className="text-muted-foreground text-xs">{t('folderPicker.loading')}</span>
            )}
            {breadcrumbs.map((crumb, i) => (
              <div key={crumb.path} className="flex shrink-0 items-center gap-0.5">
                {i > 0 && <ChevronRight className="icon-xs text-muted-foreground/50 shrink-0" />}
                <button
                  onClick={() => loadDir(crumb.path)}
                  className={`hover:bg-accent hover:text-foreground max-w-[120px] truncate rounded px-1 py-0.5 text-xs transition-colors ${
                    i === breadcrumbs.length - 1
                      ? 'text-foreground font-medium'
                      : 'text-muted-foreground'
                  }`}
                  title={crumb.path}
                >
                  {crumb.label}
                </button>
              </div>
            ))}
          </div>

          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setCreatingFolder(true);
              setNewFolderName('');
              setNewFolderError('');
            }}
            disabled={!currentPath || loading}
            className="text-muted-foreground ml-1 h-6 shrink-0 px-2 text-xs"
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
              <Button
                key={root}
                variant="ghost"
                size="sm"
                onClick={() => loadDir(root)}
                className="text-muted-foreground h-6 px-2 text-xs"
                title={root}
              >
                <HardDrive className="icon-xs mr-1" />
                {root.replace(':\\', '')}
              </Button>
            ))}
          </div>
        )}

        {/* Search filter — stays mounted during navigation loads to avoid a layout jump */}
        {dirs.length > 0 && (
          <div className="border-border border-b px-4 py-2">
            <div className="relative">
              <Search className="icon-xs text-muted-foreground absolute top-1/2 left-2 -translate-y-1/2" />
              <Input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('folderPicker.searchPlaceholder')}
                className="h-7 pr-2 pl-7 text-xs"
                autoFocus={false}
              />
            </div>
          </div>
        )}

        {/* Directory listing */}
        <div className="flex min-h-0 flex-1 flex-col p-2">
          {/* Inline new folder creation */}
          {creatingFolder && (
            <div className="bg-accent/50 mb-1 flex items-center gap-2 rounded-md px-2 py-1.5">
              <FolderPlus className="icon-sm text-status-info shrink-0" />
              <Input
                ref={newFolderInputRef}
                type="text"
                value={newFolderName}
                onChange={(e) => {
                  setNewFolderName(e.target.value);
                  setNewFolderError('');
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreateFolder();
                  if (e.key === 'Escape') cancelCreateFolder();
                }}
                placeholder={t('folderPicker.newFolderPlaceholder')}
                className="font-mono-explorer h-6 flex-1 text-xs"
                data-testid="folder-picker-new-folder-input"
              />
              <TooltipIconButton
                size="icon"
                onClick={handleCreateFolder}
                disabled={!newFolderName.trim()}
                className="size-6 shrink-0"
                tooltip={t('folderPicker.create')}
                data-testid="folder-picker-new-folder-confirm"
              >
                <Check className="icon-xs" />
              </TooltipIconButton>
              <TooltipIconButton
                size="icon"
                onClick={cancelCreateFolder}
                className="size-6 shrink-0"
                tooltip={t('folderPicker.cancel')}
                data-testid="folder-picker-new-folder-cancel"
              >
                <X className="icon-xs" />
              </TooltipIconButton>
            </div>
          )}
          {newFolderError && (
            <p className="text-status-error mb-1 px-2 text-xs">{newFolderError}</p>
          )}

          {/* Status messages center in the listing area; the list only renders
              when there's something to show. */}
          {error ? (
            <div className="flex flex-1 items-center justify-center">
              <p className="text-status-error px-2 text-center text-xs">{error}</p>
            </div>
          ) : loading ? (
            <div className="flex flex-1 items-center justify-center">
              <p className="text-muted-foreground px-2 text-center text-xs">
                {t('folderPicker.loading')}
              </p>
            </div>
          ) : dirs.length === 0 ? (
            <div className="flex flex-1 items-center justify-center">
              <p className="text-muted-foreground px-2 text-center text-xs">
                {t('folderPicker.noSubdirs')}
              </p>
            </div>
          ) : filteredDirs.length === 0 ? (
            <div className="flex flex-1 items-center justify-center">
              <p className="text-muted-foreground px-2 text-center text-xs">
                {t('folderPicker.noResults')}
              </p>
            </div>
          ) : (
            <ScrollArea className="-mx-2 min-h-0 flex-1 px-2">
              {filteredDirs.map((dir) => (
                <button
                  key={dir.path}
                  onClick={() => loadDir(dir.path)}
                  className="text-muted-foreground hover:bg-accent hover:text-foreground flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors"
                >
                  <Folder className="icon-sm text-status-info shrink-0" />
                  <span className="font-mono-explorer truncate">{dir.name}</span>
                  <ChevronRight className="icon-xs ml-auto shrink-0 opacity-40" />
                </button>
              ))}
            </ScrollArea>
          )}
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
