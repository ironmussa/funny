import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Folder, ChevronRight, Home, HardDrive, ArrowUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';

interface FolderPickerProps {
  onSelect: (path: string) => void;
  onClose: () => void;
}

interface DirEntry {
  name: string;
  path: string;
}

export function FolderPicker({ onSelect, onClose }: FolderPickerProps) {
  const { t } = useTranslation();
  const [currentPath, setCurrentPath] = useState('');
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [dirs, setDirs] = useState<DirEntry[]>([]);
  const [roots, setRoots] = useState<string[]>([]);
  const [home, setHome] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Load drive roots on mount, restore last path
  useEffect(() => {
    fetch('/api/browse/roots')
      .then((r) => r.json())
      .then(async (data) => {
        setRoots(data.roots || []);
        setHome(data.home || '');
        const lastPath = localStorage.getItem('a-parallel:last-browse-path');
        if (lastPath && lastPath !== data.home) {
          // Try saved path first; fall back to home on error
          try {
            const res = await fetch(`/api/browse/list?path=${encodeURIComponent(lastPath)}`);
            const result = await res.json();
            if (result.error) {
              localStorage.removeItem('a-parallel:last-browse-path');
              loadDir(data.home);
            } else {
              setCurrentPath(result.path);
              setParentPath(result.parent);
              setDirs(result.dirs);
              setLoading(false);
            }
          } catch {
            localStorage.removeItem('a-parallel:last-browse-path');
            loadDir(data.home);
          }
        } else {
          loadDir(data.home);
        }
      })
      .catch((e) => {
        setError(e.message);
        setLoading(false);
      });
  }, []);

  const loadDir = async (path: string) => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/browse/list?path=${encodeURIComponent(path)}`);
      const data = await res.json();
      if (data.path) setCurrentPath(data.path);
      if (data.parent !== undefined) setParentPath(data.parent);
      if (data.dirs) setDirs(data.dirs);
      if (data.error) {
        setError(data.error);
        setLoading(false);
        return;
      }
      localStorage.setItem('a-parallel:last-browse-path', data.path);
    } catch (e: any) {
      setError(e.message);
    }
    setLoading(false);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md p-0 gap-0 flex flex-col" style={{ height: '480px' }}>
        <DialogHeader className="p-4 pb-0">
          <DialogTitle className="text-sm">{t('folderPicker.title')}</DialogTitle>
        </DialogHeader>

        {/* Current path */}
        <div className="px-4 py-2 border-b border-border bg-muted/30">
          <p className="text-xs text-muted-foreground truncate font-mono" title={currentPath}>
            {currentPath || t('folderPicker.loading')}
          </p>
        </div>

        {/* Navigation buttons */}
        <div className="flex gap-1 px-4 py-2 border-b border-border">
          {parentPath && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => loadDir(parentPath)}
              className="h-7 text-xs text-muted-foreground"
            >
              <ArrowUp className="h-3 w-3 mr-1" />
              {t('folderPicker.up')}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => loadDir(home)}
            className="h-7 text-xs text-muted-foreground"
          >
            <Home className="h-3 w-3 mr-1" />
            {t('folderPicker.home')}
          </Button>
          {roots.map((root) => (
            <Button
              key={root}
              variant="ghost"
              size="sm"
              onClick={() => loadDir(root)}
              className="h-7 text-xs text-muted-foreground"
              title={root}
            >
              <HardDrive className="h-3 w-3 mr-1" />
              {root.replace(':\\', '')}
            </Button>
          ))}
        </div>

        {/* Directory listing */}
        <ScrollArea className="flex-1 p-2">
          {error && (
            <p className="text-xs text-red-400 px-2 py-1">{error}</p>
          )}
          {loading && !error && (
            <p className="text-xs text-muted-foreground px-2 py-4 text-center">{t('folderPicker.loading')}</p>
          )}
          {!loading && dirs.length === 0 && !error && (
            <p className="text-xs text-muted-foreground px-2 py-4 text-center">{t('folderPicker.noSubdirs')}</p>
          )}
          {dirs.map((dir) => (
            <button
              key={dir.path}
              onClick={() => loadDir(dir.path)}
              className="w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            >
              <Folder className="h-3.5 w-3.5 flex-shrink-0 text-blue-400" />
              <span className="truncate">{dir.name}</span>
              <ChevronRight className="h-3 w-3 flex-shrink-0 ml-auto opacity-40" />
            </button>
          ))}
        </ScrollArea>

        {/* Actions */}
        <DialogFooter className="p-4 border-t border-border">
          <Button variant="outline" size="sm" onClick={onClose}>
            {t('folderPicker.cancel')}
          </Button>
          <Button
            size="sm"
            onClick={() => onSelect(currentPath)}
            disabled={!currentPath}
          >
            {t('folderPicker.selectFolder')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
