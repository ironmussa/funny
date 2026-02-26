import { Folder, ChevronRight, Home, HardDrive, ArrowLeft, ArrowRight, Search } from 'lucide-react';
import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';

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
  const [home, setHome] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');

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
      setHome(data.home || '');
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
    return dirs.filter((d) => d.name.toLowerCase().includes(q));
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
    setSearch('');
    const result = await api.browseList(path);
    if (result.isErr()) {
      setError(result.error.message);
      setLoading(false);
      return;
    }
    const data = result.value;
    if (data.path) setCurrentPath(data.path);
    if (data.parent !== undefined) setParentPath(data.parent);
    if (data.dirs) setDirs(data.dirs);
    if (data.error) {
      setError(data.error);
      setLoading(false);
      return;
    }
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

  const breadcrumbs = useMemo(() => buildBreadcrumbs(currentPath), [currentPath]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="flex flex-col gap-0 p-0"
        style={{ maxWidth: '60vw', height: '70vh' }}
      >
        <DialogHeader className="p-4 pb-0">
          <DialogTitle className="text-sm">{t('folderPicker.title')}</DialogTitle>
        </DialogHeader>

        {/* Navigation bar: back/forward + breadcrumbs */}
        <div className="flex items-center gap-1 border-b border-border bg-muted/30 px-4 py-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={goBack}
            disabled={!canGoBack}
            className="h-6 w-6 flex-shrink-0"
            title={t('folderPicker.back')}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={goForward}
            disabled={!canGoForward}
            className="h-6 w-6 flex-shrink-0"
            title={t('folderPicker.forward')}
          >
            <ArrowRight className="h-3.5 w-3.5" />
          </Button>

          {/* Breadcrumb path */}
          <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
            {breadcrumbs.length === 0 && (
              <span className="text-xs text-muted-foreground">{t('folderPicker.loading')}</span>
            )}
            {breadcrumbs.map((crumb, i) => (
              <div key={crumb.path} className="flex flex-shrink-0 items-center gap-0.5">
                {i > 0 && (
                  <ChevronRight className="h-3 w-3 flex-shrink-0 text-muted-foreground/50" />
                )}
                <button
                  onClick={() => loadDir(crumb.path)}
                  className={`max-w-[120px] truncate rounded px-1 py-0.5 text-xs transition-colors hover:bg-accent hover:text-foreground ${
                    i === breadcrumbs.length - 1
                      ? 'font-medium text-foreground'
                      : 'text-muted-foreground'
                  }`}
                  title={crumb.path}
                >
                  {crumb.label}
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* Quick navigation buttons */}
        <div className="flex gap-1 border-b border-border px-4 py-1.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => loadDir(home)}
            className="h-6 px-2 text-xs text-muted-foreground"
          >
            <Home className="mr-1 h-3 w-3" />
            {t('folderPicker.home')}
          </Button>
          {roots.map((root) => (
            <Button
              key={root}
              variant="ghost"
              size="sm"
              onClick={() => loadDir(root)}
              className="h-6 px-2 text-xs text-muted-foreground"
              title={root}
            >
              <HardDrive className="mr-1 h-3 w-3" />
              {root.replace(':\\', '')}
            </Button>
          ))}
        </div>

        {/* Search filter */}
        {!loading && dirs.length > 0 && (
          <div className="border-b border-border px-4 py-2">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('folderPicker.searchPlaceholder')}
                className="h-7 pl-7 pr-2 text-xs"
                autoFocus={false}
              />
            </div>
          </div>
        )}

        {/* Directory listing */}
        <ScrollArea className="flex-1 p-2">
          {error && <p className="px-2 py-1 text-xs text-status-error">{error}</p>}
          {loading && !error && (
            <p className="px-2 py-4 text-center text-xs text-muted-foreground">
              {t('folderPicker.loading')}
            </p>
          )}
          {!loading && dirs.length === 0 && !error && (
            <p className="px-2 py-4 text-center text-xs text-muted-foreground">
              {t('folderPicker.noSubdirs')}
            </p>
          )}
          {!loading && dirs.length > 0 && filteredDirs.length === 0 && (
            <p className="px-2 py-4 text-center text-xs text-muted-foreground">
              {t('folderPicker.noResults')}
            </p>
          )}
          {filteredDirs.map((dir) => (
            <button
              key={dir.path}
              onClick={() => loadDir(dir.path)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Folder className="h-3.5 w-3.5 flex-shrink-0 text-status-info" />
              <span className="truncate">{dir.name}</span>
              <ChevronRight className="ml-auto h-3 w-3 flex-shrink-0 opacity-40" />
            </button>
          ))}
        </ScrollArea>

        {/* Actions */}
        <DialogFooter className="border-t border-border p-4">
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
