import type { VirtualItem, Virtualizer } from '@tanstack/react-virtual';

import { getCachedPrepared, isPretextReady, layoutSync } from '@/hooks/use-pretext';
import { analyzeMarkdown } from '@/lib/markdown-to-plaintext';
import { parseReferencedFiles } from '@/lib/parse-referenced-files';
import type { RenderItem } from '@/lib/render-items';

import type { MessageItem, VirtualRow } from './MemoizedMessageList.virtualRows';

export const VIRTUAL_ROW_GAP_PX = 16;
export const VIRTUAL_OVERSCAN = 8;

const USER_MESSAGE_ROW_PADDING_PX = 24;
const USER_MESSAGE_CARD_VERTICAL_CHROME_PX = 38;
const USER_MESSAGE_COLLAPSED_TEXT_PX = 48;
const USER_MESSAGE_EXPAND_BUTTON_PX = 20;
const USER_MESSAGE_ATTACHMENT_ROW_PX = 48;
const USER_MESSAGE_FILE_CHIP_ROW_PX = 28;
const USER_MESSAGE_MIN_ESTIMATE_PX = 112;

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

export function estimateItemHeight(
  item: RenderItem,
  containerWidth = 0,
  fonts?: FontConfig,
): number {
  if (item.type === 'message') {
    if (item.msg.role === 'user') return estimateUserMessageHeight(item.msg, containerWidth, fonts);
    return estimateAssistantMessageHeight(item, containerWidth, fonts);
  }
  if (item.type === 'toolcall') return 44;
  if (item.type === 'toolcall-group') return 44;
  if (item.type === 'toolcall-run') return 44 * item.items.length;
  if (item.type === 'thread-event') return 32;
  if (item.type === 'compaction-event') return 32;
  if (item.type === 'workflow-event-group') return 32;
  return 60;
}

export function estimateVirtualRowHeight(
  row: VirtualRow | undefined,
  containerWidth: number,
  fonts: FontConfig,
) {
  if (!row) return 60;
  if (row.type === 'session-summary') return 72;
  return estimateItemHeight(row.item, containerWidth, fonts);
}

export function getObservedBlockSize(entry: ResizeObserverEntry | undefined) {
  const size = entry?.borderBoxSize as
    | ResizeObserverSize
    | readonly ResizeObserverSize[]
    | undefined;
  if (!size) return undefined;
  return 'blockSize' in size ? size.blockSize : size[0]?.blockSize;
}

export function getElementBottomRelativeToContainer(
  element: HTMLElement,
  container: HTMLElement | null,
) {
  if (!container) return undefined;
  if (!container.contains(element)) return undefined;
  const elementRect = element.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  return elementRect.bottom - containerRect.top;
}

export function buildFallbackVirtualItems(
  virtualRows: VirtualRow[],
  heightCache: Map<string, number>,
  containerWidth: number,
  fonts: FontConfig,
) {
  let offset = 0;
  return virtualRows.map((row, index) => {
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
    return item;
  });
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

export function shouldAdjustScrollPositionOnItemSizeChange<
  TScrollElement extends Element | Window,
  TItemElement extends Element,
>(item: VirtualItem, _delta: number, instance: Virtualizer<TScrollElement, TItemElement>) {
  // TanStack keeps programmatic scroll state on the instance. Preserve those
  // adjustments for scrollToIndex/scrollToOffset, but avoid first-measurement
  // scrollTop writes while the user is actively scrolling by hand.
  const isProgrammaticScroll = Boolean(
    (instance as unknown as { scrollState?: unknown }).scrollState,
  );
  const isFirstMeasurement = !instance.itemSizeCache.has(item.key);

  if (isFirstMeasurement && instance.isScrolling && !isProgrammaticScroll) {
    return false;
  }

  return item.start < (instance.scrollOffset ?? 0);
}
