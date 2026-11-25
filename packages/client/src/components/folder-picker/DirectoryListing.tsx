import { ChevronRight, FolderIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { EmptyState } from '@/components/ui/empty-state';
import { LoadingState } from '@/components/ui/loading-state';
import { ScrollArea } from '@/components/ui/scroll-area';

interface DirEntry {
  name: string;
  path: string;
}

interface DirectoryListingProps {
  error: string;
  loading: boolean;
  dirs: DirEntry[];
  filteredDirs: DirEntry[];
  onOpen: (path: string) => void;
}

/**
 * The folder picker's directory list. Status messages center in the listing
 * area; the list only renders when there's something to show.
 */
export function DirectoryListing({
  error,
  loading,
  dirs,
  filteredDirs,
  onOpen,
}: DirectoryListingProps) {
  const { t } = useTranslation();
  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-status-error px-2 text-center text-xs">{error}</p>
      </div>
    );
  }
  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center px-2">
        <LoadingState fill={false} label={t('folderPicker.loading')} />
      </div>
    );
  }
  if (dirs.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <EmptyState fill={false} inset="sm" title={t('folderPicker.noSubdirs')} />
      </div>
    );
  }
  if (filteredDirs.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <EmptyState fill={false} inset="sm" title={t('folderPicker.noResults')} />
      </div>
    );
  }
  return (
    <ScrollArea className="-mx-2 min-h-0 flex-1" viewportProps={{ className: 'px-2' }}>
      {filteredDirs.map((dir) => (
        <button
          key={dir.path}
          onClick={() => onOpen(dir.path)}
          className="text-muted-foreground hover:bg-accent hover:text-foreground flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors"
        >
          <FolderIcon className="icon-sm text-status-info shrink-0" />
          <span className="font-mono-explorer truncate">{dir.name}</span>
          <ChevronRight className="icon-xs ml-auto shrink-0 opacity-40" />
        </button>
      ))}
    </ScrollArea>
  );
}
