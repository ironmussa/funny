import { AUTO_RESUME_MESSAGE_AUTHOR } from '@funny/shared';
import type { VirtualItem } from '@tanstack/react-virtual';

import { getCachedPrepared, isPretextReady, layoutSync } from '@/hooks/use-pretext';
import { analyzeMarkdown } from '@/lib/markdown-to-plaintext';
import { parseReferencedFiles } from '@/lib/parse-referenced-files';
import type { RenderItem } from '@/lib/render-items';

import type { MessageItem, VirtualRow } from './MemoizedMessageList.virtualRows';

export const VIRTUAL_ROW_GAP_PX = 16;
// Four rows on either side keeps a scroll buffer while avoiding eager markdown
// parsing for a full screen of messages that may never become visible.
export const VIRTUAL_OVERSCAN = 4;
// Before TanStack Virtual receives its first scroll measurement, render only
// the active end of the thread. A direct thread load is restored to that end,
// and rendering the complete history for this one-frame fallback can otherwise
// synchronously parse hundreds of markdown messages before the LCP can paint.
export const INITIAL_FALLBACK_RENDER_COUNT = VIRTUAL_OVERSCAN * 2 + 1;

const USER_MESSAGE_ROW_PADDING_PX = 12;
const USER_MESSAGE_CARD_VERTICAL_CHROME_PX = 38;
const USER_MESSAGE_COLLAPSED_TEXT_PX = 48;
const USER_MESSAGE_EXPAND_BUTTON_PX = 20;
const USER_MESSAGE_ATTACHMENT_ROW_PX = 48;
const USER_MESSAGE_FILE_CHIP_ROW_PX = 28;
// Hover footer (model, mode, time, actions) below the card; it always reserves its height.
const USER_MESSAGE_FOOTER_PX = 28;
const USER_MESSAGE_MIN_ESTIMATE_PX = 100;
// The auto-resume divider that replaces the user card (`AutoResumeMarker`).
const AUTO_RESUME_MARKER_PX = 24;

export interface FontConfig {
  proseFont: string;
  proseLineHeight: number;
  codeLineHeight: number;
}

/**
 * Estimate item height. Message rows use pretext measurements when available,
 * then fall back to conservative estimates until ResizeObserver reports the
 * real row height.
 * containerWidth = 0 means "use flat fallback" (pretext not ready or width unknown).
 */
function estimatePlainTextHeight(text: string, containerWidth: number, fonts?: FontConfig): number {
  const lineHeight = fonts?.proseLineHeight ?? 20;
  if (!text) return lineHeight;

  if (containerWidth > 100 && isPretextReady() && fonts) {
    const prepared = getCachedPrepared(text, fonts.proseFont);
    if (prepared) {
      return layoutSync(prepared, containerWidth, fonts.proseLineHeight).height;
    }
  }

  const approxCharPx = 7;
  const textWidth = Math.max(120, containerWidth);
  return text.split('\n').reduce((height, line) => {
    const visualLines = Math.max(1, Math.ceil((line.length * approxCharPx) / textWidth));
    return height + visualLines * lineHeight;
  }, 0);
}

function estimateUserMessageHeight(msg: any, containerWidth: number, fonts?: FontConfig): number {
  const { files, inlineContent } = parseReferencedFiles(msg.content ?? '');
  const content = inlineContent.trim();
  const cardTextWidth = Math.max(120, containerWidth - 24);
  const fullTextHeight = estimatePlainTextHeight(content, cardTextWidth, fonts);
  const textHeight = Math.min(fullTextHeight, USER_MESSAGE_COLLAPSED_TEXT_PX);
  const expandButtonHeight =
    fullTextHeight > USER_MESSAGE_COLLAPSED_TEXT_PX ? USER_MESSAGE_EXPAND_BUTTON_PX : 0;

  const imageCount = msg.images?.length ?? 0;
  const imagesPerRow = Math.max(1, Math.floor(cardTextWidth / 104));
  const imageRows = imageCount > 0 ? Math.ceil(imageCount / imagesPerRow) : 0;
  const imageHeight = imageRows * USER_MESSAGE_ATTACHMENT_ROW_PX;

  const unmentionedFileCount = files.filter(
    (file) => !inlineContent.includes(`@${file.path}`),
  ).length;
  const chipsPerRow = Math.max(1, Math.floor(cardTextWidth / 160));
  const fileChipRows = unmentionedFileCount > 0 ? Math.ceil(unmentionedFileCount / chipsPerRow) : 0;
  const fileChipHeight = fileChipRows * USER_MESSAGE_FILE_CHIP_ROW_PX;

  return Math.max(
    USER_MESSAGE_MIN_ESTIMATE_PX,
    USER_MESSAGE_ROW_PADDING_PX +
      USER_MESSAGE_CARD_VERTICAL_CHROME_PX +
      USER_MESSAGE_FOOTER_PX +
      imageHeight +
      fileChipHeight +
      textHeight +
      expandButtonHeight,
  );
}

function estimateAssistantMessageHeight(
  item: MessageItem,
  containerWidth: number,
  fonts?: FontConfig,
): number {
  const content = item.msg.content?.trim();
  if (content && containerWidth > 100 && isPretextReady() && fonts) {
    const analysis = analyzeMarkdown(content);
    const prepared = getCachedPrepared(analysis.plainText, fonts.proseFont);
    if (prepared) {
      // Effective text width: container minus avatar(32) + gap(8) + copyBtn(32) + gap(8) + padding(32)
      const textWidth = containerWidth - 112;
      const { height: proseHeight } = layoutSync(prepared, textWidth, fonts.proseLineHeight);
      // Code blocks: monospace lines + padding per block
      const codeHeight =
        analysis.codeBlockLines * fonts.codeLineHeight + analysis.codeBlockCount * 16;
      // Fixed chrome: timestamp(20px) + gap(8px)
      const totalHeight = proseHeight + codeHeight + analysis.extraHeightPx + 28;
      return Math.max(totalHeight, 60);
    }
  }
  return 120;
}

function estimateMessageHeight(
  item: Extract<RenderItem, { type: 'message' }>,
  containerWidth: number,
  fonts?: FontConfig,
): number {
  if (item.msg.role !== 'user') return estimateAssistantMessageHeight(item, containerWidth, fonts);
  if (item.msg.author === AUTO_RESUME_MESSAGE_AUTHOR) return AUTO_RESUME_MARKER_PX;
  return estimateUserMessageHeight(item.msg, containerWidth, fonts);
}

export function estimateItemHeight(
  item: RenderItem,
  containerWidth = 0,
  fonts?: FontConfig,
): number {
  if (item.type === 'message') return estimateMessageHeight(item, containerWidth, fonts);
  if (item.type === 'toolcall') return 44;
  if (item.type === 'toolcall-group') return 44;
  if (item.type === 'toolcall-run') return 44 * item.items.length;
  if (item.type === 'thread-event') return item.event.type === 'sandbox:error' ? 80 : 32;
  if (item.type === 'compaction-event') return 32;
  if (item.type === 'workflow-event-group') return 32;
  if (item.type === 'factory-card') return item.card.kind === 'proof' ? 140 : 100;
  return 60;
}

export function estimateVirtualRowHeight(
  row: VirtualRow | undefined,
  containerWidth: number,
  fonts: FontConfig,
) {
  if (!row) return 60;
  if (row.type === 'session-summary') return 72;
  if (row.type === 'turn-end') return 28;
  return estimateItemHeight(row.item, containerWidth, fonts);
}

/** What an estimate was computed from; a different value means the row needs a new one. */
function getRowEstimateInput(row: VirtualRow | undefined): number {
  if (row?.type !== 'item') return 0;
  if (row.item.type === 'message') return row.item.msg.content?.length ?? 0;
  if (row.item.type === 'toolcall-run') return row.item.items.length;
  return 0;
}

export interface RowEstimateCache {
  estimate: (
    row: VirtualRow | undefined,
    containerWidth: number,
    fonts: FontConfig,
    layoutKey: string,
  ) => number;
  clear: () => void;
}

/**
 * Keeps the estimated height of an unmeasured row the same from one render to
 * the next. The virtualizer asks for every unmeasured row's estimate on each
 * render, and a text estimate changes once pretext has prepared that text. A
 * row above the viewport that changed its estimate moved everything below it,
 * with no scroll correction: the view jumped on the first scroll after the
 * thread opened. An estimate now changes only with the layout, with the row's
 * content, or after `clear()`, whose caller keeps the scroll position.
 */
export function createRowEstimateCache(): RowEstimateCache {
  const entries = new Map<string, { layoutKey: string; input: number; size: number }>();

  return {
    estimate(row, containerWidth, fonts, layoutKey) {
      if (!row) return estimateVirtualRowHeight(row, containerWidth, fonts);

      const input = getRowEstimateInput(row);
      const cached = entries.get(row.key);
      if (cached && cached.layoutKey === layoutKey && cached.input === input) return cached.size;

      const size = estimateVirtualRowHeight(row, containerWidth, fonts);
      entries.set(row.key, { layoutKey, input, size });
      return size;
    },
    clear() {
      entries.clear();
    },
  };
}

export function getObservedBlockSize(entry: ResizeObserverEntry | undefined) {
  const size = entry?.borderBoxSize as
    | ResizeObserverSize
    | readonly ResizeObserverSize[]
    | undefined;
  if (!size) return undefined;
  return 'blockSize' in size ? size.blockSize : size[0]?.blockSize;
}

/**
 * Bottom of a mounted row relative to the item container, from the offset the
 * row was rendered at (`data-row-offset`, the same value as its translateY).
 * Reads no layout, so measuring a row never forces a synchronous reflow.
 */
export function getRowBottomFromRenderedOffset(element: HTMLElement, height: number) {
  if (!element.isConnected) return undefined;
  const offset = Number(element.dataset.rowOffset);
  return Number.isFinite(offset) ? offset + height : undefined;
}

export function buildFallbackVirtualItems(
  virtualRows: VirtualRow[],
  heightCache: Map<string, number>,
  containerWidth: number,
  fonts: FontConfig,
  maxRenderedItems = virtualRows.length,
) {
  let offset = 0;
  const firstRenderedIndex = Math.max(0, virtualRows.length - maxRenderedItems);
  const renderedItems: VirtualItem[] = [];

  for (let index = 0; index < virtualRows.length; index++) {
    const row = virtualRows[index];
    const size = heightCache.get(row.key) ?? estimateVirtualRowHeight(row, containerWidth, fonts);
    const item = {
      key: row.key,
      index,
      start: offset,
      size,
      end: offset + size,
      lane: 0,
    };
    offset = item.end + VIRTUAL_ROW_GAP_PX;
    if (index >= firstRenderedIndex) renderedItems.push(item);
  }
  return renderedItems;
}

export function getMeasuredLastRowBottom({
  heightCache,
  lastVirtualItem,
  lastRow,
  leadingStickySpacerHeight,
  listScrollMargin,
}: {
  heightCache: Map<string, number>;
  lastVirtualItem: Pick<VirtualItem, 'start'> | undefined;
  lastRow: VirtualRow | undefined;
  leadingStickySpacerHeight: number;
  listScrollMargin: number;
}) {
  const measuredLastRowHeight = lastRow ? heightCache.get(lastRow.key) : undefined;
  return lastVirtualItem && measuredLastRowHeight !== undefined
    ? lastVirtualItem.start - listScrollMargin + leadingStickySpacerHeight + measuredLastRowHeight
    : undefined;
}

export function getVirtualContentHeight({
  fallbackContentHeight,
  leadingStickySpacerHeight,
  measuredContentBottom,
  measuredLastRowBottom,
  virtualizerTotalSize,
}: {
  fallbackContentHeight: number;
  leadingStickySpacerHeight: number;
  measuredContentBottom: number;
  measuredLastRowBottom: number | undefined;
  virtualizerTotalSize: number;
}) {
  return measuredLastRowBottom !== undefined
    ? Math.max(0, measuredLastRowBottom)
    : Math.max(
        virtualizerTotalSize + leadingStickySpacerHeight,
        measuredContentBottom,
        fallbackContentHeight + leadingStickySpacerHeight,
      );
}
