import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Loader2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Dialog, DialogOverlay, DialogPortal, DialogTitle } from '@/components/ui/dialog';
import { HighlightText } from '@/components/ui/highlight-text';
import { api } from '@/lib/api';
import { FileExtensionIcon } from '@/lib/file-icons';
import { useInternalEditorStore } from '@/stores/internal-editor-store';
import { useProjectStore } from '@/stores/project-store';

interface FileSearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface BrowseFile {
  path: string;
  type: 'file' | 'folder';
}

export function FileSearchDialog({ open, onOpenChange }: FileSearchDialogProps) {
  const { t } = useTranslation();
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const projects = useProjectStore((s) => s.projects);
  const project = projects.find((p) => p.id === selectedProjectId);

  const [query, setQuery] = useState('');
  const [allFiles, setAllFiles] = useState<BrowseFile[]>([]);
  const [loading, setLoading] = useState(false);

  // Fetch all files once when dialog opens
  useEffect(() => {
    if (!open || !project) return;

    let cancelled = false;
    const fetchFiles = async () => {
      setLoading(true);
      const result = await api.browseFiles(project.path);
      if (!cancelled && result.isOk()) {
        const normalized: BrowseFile[] = result.value.files
          .map((f) => (typeof f === 'string' ? { path: f, type: 'file' as const } : f))
          .filter((f) => f.type === 'file');
        setAllFiles(normalized);
      }
      if (!cancelled) setLoading(false);
    };

    fetchFiles();
    return () => {
      cancelled = true;
    };
  }, [open, project]);

  // Filter and sort files client-side
  const { files, truncated } = useMemo(() => {
    if (!query) {
      const isTruncated = allFiles.length > 200;
      return { files: allFiles.slice(0, 200), truncated: isTruncated };
    }

    const lowerQuery = query.toLowerCase();
    const scored: Array<{ file: BrowseFile; score: number }> = [];

    for (const file of allFiles) {
      const fileName = getFileName(file.path).toLowerCase();
      const filePath = file.path.toLowerCase();

      if (fileName.includes(lowerQuery)) {
        // Exact substring match in filename — highest priority
        // Bonus if it starts with the query
        scored.push({ file, score: fileName.startsWith(lowerQuery) ? 0 : 1 });
      } else if (fuzzyMatch(fileName, lowerQuery)) {
        // Fuzzy match in filename
        scored.push({ file, score: 2 });
      } else if (filePath.includes(lowerQuery)) {
        // Match in directory path only
        scored.push({ file, score: 3 });
      }
    }

    scored.sort((a, b) => a.score - b.score);
    const isTruncated = scored.length > 200;
    return { files: scored.slice(0, 200).map((s) => s.file), truncated: isTruncated };
  }, [allFiles, query]);

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setQuery('');
      setAllFiles([]);
    }
  }, [open]);

  const handleSelect = useCallback(
    (relativePath: string) => {
      if (!project) return;
      onOpenChange(false);
      const absolutePath = `${project.path}/${relativePath}`;
      useInternalEditorStore.getState().openFile(absolutePath);
    },
    [onOpenChange, project],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed left-[50%] top-[20%] z-50 w-full max-w-lg translate-x-[-50%] overflow-hidden rounded-lg border bg-card p-0 shadow-xl data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in"
        >
          <DialogTitle className="sr-only">{t('fileSearch.title', 'Search files')}</DialogTitle>
          <Command
            shouldFilter={false}
            className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-1.5"
          >
            <CommandInput
              data-testid="file-search-input"
              placeholder={t('fileSearch.placeholder', 'Search files by name...')}
              value={query}
              onValueChange={setQuery}
            />
            <CommandList>
              <CommandEmpty>
                {!project ? (
                  <span>{t('fileSearch.noProject', 'Select a project first')}</span>
                ) : loading ? (
                  <div className="flex items-center justify-center gap-2">
                    <Loader2 className="icon-sm animate-spin" />
                    <span>{t('fileSearch.searching', 'Searching...')}</span>
                  </div>
                ) : (
                  <span>{t('fileSearch.noResults', 'No files found')}</span>
                )}
              </CommandEmpty>
              {files.length > 0 && (
                <CommandGroup heading={t('fileSearch.files', 'Files')}>
                  {files.map((file) => (
                    <CommandItem
                      key={file.path}
                      data-testid={`file-search-item-${file.path}`}
                      value={file.path}
                      onSelect={() => handleSelect(file.path)}
                    >
                      <FileExtensionIcon filePath={file.path} className="icon-base flex-shrink-0" />
                      <HighlightText
                        text={getFileName(file.path)}
                        query={query}
                        className="truncate text-xs"
                      />
                      <span className="truncate text-xs text-muted-foreground">{file.path}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
              {truncated && (
                <div className="px-2 py-1.5 text-center text-xs text-muted-foreground">
                  {t('fileSearch.truncated', 'Showing first 200 results — refine your search')}
                </div>
              )}
            </CommandList>
          </Command>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}

function getFileName(filePath: string): string {
  return filePath.split(/[/\\]/).pop() || filePath;
}

/** Simple fuzzy match: all characters of the query appear in order within the text */
function fuzzyMatch(text: string, query: string): boolean {
  let qi = 0;
  for (let ti = 0; ti < text.length && qi < query.length; ti++) {
    if (text[ti] === query[qi]) qi++;
  }
  return qi === query.length;
}
