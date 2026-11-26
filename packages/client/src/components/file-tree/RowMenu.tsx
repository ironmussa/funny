import { ClipboardCopy, Copy, MoreHorizontal } from 'lucide-react';
import type { ReactNode, RefObject } from 'react';
import { useTranslation } from 'react-i18next';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface RowMenuProps {
  triggerTestId: string;
  /** Records when the menu closed, so the click that closed it does not open the row. */
  dropdownCloseRef: RefObject<number>;
  children: ReactNode;
}

/** The "More actions" menu shown on hover at the end of a FileTree row. */
export function RowMenu({ triggerTestId, dropdownCloseRef, children }: RowMenuProps) {
  const { t } = useTranslation();
  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (!open) dropdownCloseRef.current = Date.now();
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          aria-label={t('review.moreActions', 'More actions')}
          className="text-muted-foreground hover:bg-sidebar-accent hover:text-foreground flex size-6 shrink-0 items-center justify-center rounded opacity-0 transition-opacity group-hover:opacity-100 data-[state=open]:opacity-100"
          data-testid={triggerTestId}
        >
          <MoreHorizontal className="icon-sm" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-[220px]"
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface CopyPathItemsProps {
  path: string;
  onCopyPath: (path: string, relative: boolean) => void;
}

/** "Copy path" and "Copy relative path" items of a row menu. */
export function CopyPathItems({ path, onCopyPath }: CopyPathItemsProps) {
  const { t } = useTranslation();
  return (
    <>
      <DropdownMenuItem
        onClick={(e) => {
          e.stopPropagation();
          onCopyPath(path, false);
        }}
      >
        <Copy />
        {t('review.copyFilePath')}
      </DropdownMenuItem>
      <DropdownMenuItem
        onClick={(e) => {
          e.stopPropagation();
          onCopyPath(path, true);
        }}
      >
        <ClipboardCopy />
        {t('review.copyRelativePath')}
      </DropdownMenuItem>
    </>
  );
}
