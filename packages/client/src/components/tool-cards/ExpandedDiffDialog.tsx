import { FileCode } from 'lucide-react';
import { Suspense } from 'react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';

import { ReactDiffViewer, DIFF_VIEWER_STYLES, getFileName } from './utils';

interface ExpandedDiffDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filePath: string;
  oldValue: string;
  newValue: string;
}

export function ExpandedDiffDialog({
  open,
  onOpenChange,
  filePath,
  oldValue,
  newValue,
}: ExpandedDiffDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[85vh] w-[90vw] max-w-[90vw] flex-col gap-0 p-0">
        <DialogHeader className="flex-shrink-0 overflow-hidden border-b border-border px-4 py-3 pr-10">
          <div className="flex min-w-0 items-center gap-2 overflow-hidden">
            <FileCode className="h-4 w-4 flex-shrink-0" />
            <DialogTitle
              className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-sm"
              style={{ direction: 'rtl', textAlign: 'left' }}
            >
              {filePath}
            </DialogTitle>
          </div>
          <DialogDescription className="sr-only">
            Diff for {getFileName(filePath)}
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="[&_.diff-container]:font-mono [&_table]:w-full [&_td]:overflow-hidden [&_td]:text-ellipsis">
            <Suspense
              fallback={<div className="p-4 text-sm text-muted-foreground">Loading diff...</div>}
            >
              <ReactDiffViewer
                oldValue={oldValue}
                newValue={newValue}
                splitView={true}
                useDarkTheme={true}
                hideLineNumbers={false}
                showDiffOnly={true}
                styles={DIFF_VIEWER_STYLES}
              />
            </Suspense>
          </div>
          <ScrollBar orientation="horizontal" />
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
