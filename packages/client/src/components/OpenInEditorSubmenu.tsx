import { ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import { editorLabels, type Editor } from '@/stores/settings-store';

interface Props {
  onPick: (editor: Editor) => void;
  testId?: string;
}

export function OpenInEditorSubmenu({ onPick, testId = 'menu-open-editor' }: Props) {
  const { t } = useTranslation();
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger data-testid={testId}>
        <ExternalLink />
        {t('thread.openInEditor', 'Open in Editor')}
      </DropdownMenuSubTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSubContent>
          {(Object.keys(editorLabels) as Editor[]).map((editor) => (
            <DropdownMenuItem
              key={editor}
              data-testid={`${testId}-${editor}`}
              onClick={(e) => {
                e.stopPropagation();
                onPick(editor);
              }}
              className="cursor-pointer"
            >
              {editorLabels[editor]}
            </DropdownMenuItem>
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  );
}
