import { ExternalLink, EyeOff, FileCode, FolderOpenDot, FolderX, Undo2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { HostDropdownMenuItem } from '@/components/HostOnly';
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import {
  openFileInExternalEditor,
  openFileInInternalEditor,
  getEditorLabel,
} from '@/lib/editor-utils';
import { getFileExtension, getParentFolders } from '@/lib/file-tree';

import type { FileTreeRowCommon } from './row-props';
import { CopyPathItems, RowMenu } from './RowMenu';

function IgnoreFolderItems({ path, onIgnore }: { path: string; onIgnore: (p: string) => void }) {
  const { t } = useTranslation();
  const folders = getParentFolders(path);
  if (folders.length === 0) return null;
  if (folders.length === 1) {
    return (
      <DropdownMenuItem
        onClick={(e) => {
          e.stopPropagation();
          onIgnore(folders[0]);
        }}
      >
        <FolderX />
        {t('review.ignoreFolder')}
      </DropdownMenuItem>
    );
  }
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <FolderX />
        {t('review.ignoreFolder')}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {folders.map((folder) => (
          <DropdownMenuItem
            key={folder}
            onClick={(e) => {
              e.stopPropagation();
              onIgnore(folder);
            }}
          >
            {folder}
          </DropdownMenuItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function IgnoreMenuItems({ path, onIgnore }: { path: string; onIgnore: (p: string) => void }) {
  const { t } = useTranslation();
  const ext = getFileExtension(path);
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        onClick={(e) => {
          e.stopPropagation();
          onIgnore(path);
        }}
      >
        <EyeOff />
        {t('review.ignoreFile')}
      </DropdownMenuItem>
      <IgnoreFolderItems path={path} onIgnore={onIgnore} />
      {ext ? (
        <DropdownMenuItem
          onClick={(e) => {
            e.stopPropagation();
            onIgnore(`*${ext}`);
          }}
        >
          <EyeOff />
          {t('review.ignoreExtension', { ext })}
        </DropdownMenuItem>
      ) : null}
    </>
  );
}

type FileTreeFileMenuProps = Pick<
  FileTreeRowCommon,
  'basePath' | 'testIdPrefix' | 'dropdownCloseRef' | 'onCopyPath' | 'onOpenDirectory'
> & {
  path: string;
  onRevertFile?: (path: string) => void;
  revertLabel?: string;
  onIgnore?: (pattern: string) => void;
};

export function FileTreeFileMenu({
  path,
  basePath,
  testIdPrefix,
  dropdownCloseRef,
  onCopyPath,
  onOpenDirectory,
  onRevertFile,
  revertLabel,
  onIgnore,
}: FileTreeFileMenuProps) {
  const { t } = useTranslation();
  return (
    <RowMenu triggerTestId={`${testIdPrefix}-menu-${path}`} dropdownCloseRef={dropdownCloseRef}>
      <HostDropdownMenuItem
        onClick={(e) => {
          e.stopPropagation();
          const fullPath = basePath ? `${basePath}/${path}` : path;
          openFileInExternalEditor(fullPath);
        }}
      >
        <ExternalLink />
        {t('review.openInEditor', { editor: getEditorLabel() })}
      </HostDropdownMenuItem>
      <DropdownMenuItem
        onClick={(e) => {
          e.stopPropagation();
          const fullPath = basePath ? `${basePath}/${path}` : path;
          openFileInInternalEditor(fullPath);
        }}
        data-testid={`file-tree-open-internal-editor-${path}`}
      >
        <FileCode />
        {t('review.openInInternalEditor')}
      </DropdownMenuItem>
      {basePath && (
        <HostDropdownMenuItem
          onClick={(e) => {
            e.stopPropagation();
            void onOpenDirectory(path, true);
          }}
          data-testid={`${testIdPrefix}-file-open-directory-${path}`}
        >
          <FolderOpenDot />
          {t('sidebar.openDirectory')}
        </HostDropdownMenuItem>
      )}
      {onRevertFile && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onClick={(e) => {
              e.stopPropagation();
              onRevertFile(path);
            }}
          >
            <Undo2 />
            {revertLabel ?? t('review.discardChanges')}
          </DropdownMenuItem>
        </>
      )}
      {onIgnore && <IgnoreMenuItems path={path} onIgnore={onIgnore} />}
      <DropdownMenuSeparator />
      <CopyPathItems path={path} onCopyPath={onCopyPath} />
    </RowMenu>
  );
}
