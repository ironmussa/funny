import type { PRReviewThread } from '@funny/shared';
import {
  Check,
  Columns2,
  Columns3,
  Copy,
  FileText,
  Loader2,
  MessageSquare,
  RectangleVertical,
  Search,
  WrapText,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { PreviewModeToggle } from '@/components/PreviewModeToggle';
import { MessageContent } from '@/components/thread/MessageContent';
import { Button } from '@/components/ui/button';
import { SearchBar } from '@/components/ui/search-bar';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

import { DiffCommentThread } from '../DiffCommentThread';
import type { DiffViewMode } from '../VirtualDiff';
import type { DiffDisplay, DiffSearch, ExpandedDiffControls } from './use-expanded-diff-controls';

/*
 * Shared toolbar / overlay pieces of the expanded diff dialog and the inline
 * expanded diff view. `testIdPrefix` keeps each host's data-testids stable
 * ('diff' for the dialog, 'diff-view' for the inline view).
 */

const VIEW_MODE_OPTIONS: {
  value: DiffViewMode;
  label: string;
  icon: typeof Columns2;
  className: string;
}[] = [
  {
    value: 'unified',
    label: 'Unified',
    icon: RectangleVertical,
    className: 'data-[state=on]:bg-accent rounded-none rounded-l-md border-0 px-1.5',
  },
  {
    value: 'split',
    label: 'Split',
    icon: Columns2,
    className: 'border-border data-[state=on]:bg-accent rounded-none border-x px-1.5',
  },
  {
    value: 'three-pane',
    label: 'Three-pane',
    icon: Columns3,
    className: 'data-[state=on]:bg-accent rounded-none rounded-r-md border-0 px-1.5',
  },
];

function DiffViewModeToggle({
  value,
  onValueChange,
  disabled,
  testIdPrefix,
}: {
  value: DiffViewMode;
  onValueChange: (value: string) => void;
  disabled: boolean;
  testIdPrefix: string;
}) {
  return (
    <ToggleGroup
      type="single"
      size="sm"
      value={value}
      onValueChange={onValueChange}
      disabled={disabled}
      className="border-border shrink-0 gap-0 rounded-md border"
      data-testid={`${testIdPrefix}-view-mode-group`}
    >
      {VIEW_MODE_OPTIONS.map(({ value: mode, label, icon: Icon, className }) => (
        <Tooltip key={mode}>
          <TooltipTrigger asChild>
            <ToggleGroupItem
              value={mode}
              className={className}
              data-testid={`${testIdPrefix}-view-mode-${mode}`}
            >
              <Icon className="icon-base" />
            </ToggleGroupItem>
          </TooltipTrigger>
          <TooltipContent side="bottom">{label}</TooltipContent>
        </Tooltip>
      ))}
    </ToggleGroup>
  );
}

function ToolbarToggleButton({
  active,
  onClick,
  disabled,
  tooltip,
  testId,
  children,
}: {
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  tooltip: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClick}
          disabled={disabled}
          className={cn(
            'shrink-0 text-muted-foreground',
            active && 'bg-accent text-accent-foreground',
          )}
          data-testid={testId}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{tooltip}</TooltipContent>
    </Tooltip>
  );
}

/** Word wrap, full-file and search toggles */
function DiffToolbarToggles({
  testIdPrefix,
  wordWrap,
  onToggleWordWrap,
  showFullFile,
  onToggleFullFile,
  fullFileBusy,
  showSearch,
  onToggleSearch,
}: {
  testIdPrefix: string;
  wordWrap: boolean;
  onToggleWordWrap: () => void;
  showFullFile: boolean;
  onToggleFullFile: () => void;
  fullFileBusy: boolean;
  showSearch: boolean;
  onToggleSearch: () => void;
}) {
  return (
    <>
      <ToolbarToggleButton
        active={wordWrap}
        onClick={onToggleWordWrap}
        tooltip={wordWrap ? 'Word wrap on' : 'Word wrap off'}
        testId={`${testIdPrefix}-toggle-word-wrap`}
      >
        <WrapText className="icon-base" />
      </ToolbarToggleButton>
      <ToolbarToggleButton
        active={showFullFile}
        onClick={onToggleFullFile}
        disabled={fullFileBusy}
        tooltip={showFullFile ? 'Show changes only' : 'Show full file'}
        testId={`${testIdPrefix}-toggle-full-file`}
      >
        {fullFileBusy ? (
          <Loader2 className="icon-base animate-spin" />
        ) : (
          <FileText className="icon-base" />
        )}
      </ToolbarToggleButton>
      <ToolbarToggleButton
        active={showSearch}
        onClick={onToggleSearch}
        tooltip="Search (Ctrl+F)"
        testId={`${testIdPrefix}-toggle-search`}
      >
        <Search className="icon-base" />
      </ToolbarToggleButton>
    </>
  );
}

/** Search bar — positioned below header, above diff content (hidden during Markdown preview) */
export function DiffSearchOverlay({
  search,
  display,
  testIdPrefix,
}: {
  search: DiffSearch;
  display: DiffDisplay;
  testIdPrefix: string;
}) {
  if (!search.showSearch || display.showMarkdownPreview) return null;
  return (
    <SearchBar
      query={search.searchQuery}
      onQueryChange={search.changeQuery}
      caseSensitive={search.searchCaseSensitive}
      onCaseSensitiveChange={search.changeCaseSensitive}
      currentIndex={search.currentMatchIndex}
      totalMatches={search.totalMatches}
      onPrev={search.goToPrevMatch}
      onNext={search.goToNextMatch}
      onClose={search.closeSearch}
      placeholder="Search in diff..."
      showIcon={false}
      testIdPrefix={`${testIdPrefix}-search`}
      className="border-border bg-popover absolute top-0 right-4 z-30 gap-1.5 rounded-b-lg border border-t-0 px-2 py-1.5 shadow-md"
    />
  );
}

export function DiffMarkdownPreview({ content, testId }: { content: string; testId: string }) {
  return (
    <div className="px-8 py-6" data-testid={testId}>
      <MessageContent content={content} />
    </div>
  );
}

/** Inline PR review threads for the current file */
export function DiffReviewThreads({
  threads,
  testId,
}: {
  threads: PRReviewThread[];
  testId: string;
}) {
  if (threads.length === 0) return null;
  return (
    <div className="border-border bg-muted/20 border-t px-4 py-3" data-testid={testId}>
      <div className="text-muted-foreground mb-2 flex items-center gap-1.5 text-xs font-medium">
        <MessageSquare className="size-3.5" />
        {threads.length} review {threads.length === 1 ? 'thread' : 'threads'}
      </div>
      <div className="space-y-2">
        {threads.map((thread) => (
          <DiffCommentThread key={thread.id} thread={thread} className="w-full max-w-none" />
        ))}
      </div>
    </div>
  );
}

/**
 * Header controls shared by the dialog and the inline view: view-mode toggle,
 * an optional host-specific slot (e.g. the dialog's copy button), the Markdown
 * preview toggle, then the word-wrap / full-file / search toggles.
 */
export function DiffHeaderControls({
  testIdPrefix,
  controls,
  display,
  children,
}: {
  testIdPrefix: string;
  controls: ExpandedDiffControls;
  display: DiffDisplay;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const { search, isPending, loadingFullDiff } = controls;
  const { showMarkdownPreview } = display;
  return (
    <>
      {!showMarkdownPreview && !display.isOneSided && (
        <DiffViewModeToggle
          value={display.viewMode}
          onValueChange={controls.handleViewModeChange}
          disabled={isPending}
          testIdPrefix={testIdPrefix}
        />
      )}
      {children}
      {display.canPreviewMarkdown && (
        <PreviewModeToggle
          previewing={showMarkdownPreview}
          onToggle={controls.toggleMarkdownPreview}
          loading={loadingFullDiff}
          testId={`${testIdPrefix}-toggle-markdown-preview`}
          sourceLabel={t('tools.viewChanges', 'View changes')}
        />
      )}
      {!showMarkdownPreview && (
        <DiffToolbarToggles
          testIdPrefix={testIdPrefix}
          wordWrap={controls.wordWrap}
          onToggleWordWrap={controls.toggleWordWrap}
          showFullFile={controls.showFullFile}
          onToggleFullFile={controls.toggleFullFile}
          fullFileBusy={isPending || loadingFullDiff}
          showSearch={search.showSearch}
          onToggleSearch={search.toggleSearch}
        />
      )}
    </>
  );
}

function CopyIcon({ loading, copied }: { loading: boolean; copied: boolean }) {
  if (loading) return <Loader2 className="icon-base animate-spin" />;
  if (copied) return <Check className="icon-base" />;
  return <Copy className="icon-base" />;
}

export function CopyFullFileButton({
  onCopy,
  disabled,
  loading,
  copied,
}: {
  onCopy: () => void;
  disabled: boolean;
  loading: boolean;
  copied: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onCopy}
          disabled={disabled}
          className="text-muted-foreground shrink-0"
          data-testid="diff-copy-full-file"
          aria-label={t('tools.copy', 'Copy file contents')}
        >
          <CopyIcon loading={loading} copied={copied} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{t('tools.copy', 'Copy file contents')}</TooltipContent>
    </Tooltip>
  );
}
