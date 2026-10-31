import type { FileDiffSummary } from '@funny/shared';

import {
  buildRenderItemIdIndexMap,
  getItemKey,
  getItemTimestamp,
  type RenderItem,
} from '@/lib/render-items';
import { buildToolCallDiffFallbacks } from '@/lib/tool-call-diff-fallbacks';

export type MessageItem = Extract<RenderItem, { type: 'message' }>;

export type VirtualRow =
  | {
      type: 'item';
      key: string;
      item: RenderItem;
      itemIndex: number;
      /** User message id of the turn this row belongs to (hover-reveal of its bar). */
      sectionId?: string;
    }
  | {
      type: 'session-summary';
      key: string;
      userItem: MessageItem;
      files: FileDiffSummary[];
      fallbackDiffs: Map<string, string>;
      isLastSection: boolean;
    }
  | {
      /** End-of-turn bar for a finished section, rendered above the next prompt. */
      type: 'turn-end';
      key: string;
      userItem: MessageItem;
      startedAt?: string;
      completedAt?: string;
      /** Prompt + text replies of the turn (tool cards are not copied). */
      messages: any[];
    };

export function getLeadingUserItem(
  leadingUserMessage: any | undefined,
  messages: any[],
): MessageItem | null {
  if (!leadingUserMessage) return null;
  if (messages.some((msg) => msg.id === leadingUserMessage.id)) return null;
  return { type: 'message', msg: leadingUserMessage };
}

export function buildVirtualRows(
  groupedItems: RenderItem[],
  sessionChanges?: Map<string, FileDiffSummary[]>,
): VirtualRow[] {
  const rows: VirtualRow[] = [];
  let currentUser: MessageItem | null = null;
  let currentSessionItems: RenderItem[] = [];

  const appendSessionSummary = () => {
    if (!currentUser) return;
    const files = sessionChanges?.get(currentUser.msg.id);
    if (!files || files.length === 0) return;
    rows.push({
      type: 'session-summary',
      key: `session-summary-${currentUser.msg.id}`,
      userItem: currentUser,
      files,
      fallbackDiffs: buildToolCallDiffFallbacks(currentSessionItems, files),
      isLastSection: false,
    });
  };

  // The thread's final turn is summarized by the status tail instead.
  const appendTurnEnd = () => {
    if (!currentUser) return;
    const completedAt = currentSessionItems
      .map(getItemTimestamp)
      .filter(Boolean)
      .reduce<string | undefined>(
        (latest, ts) => (!latest || ts > latest ? ts : latest),
        undefined,
      );
    rows.push({
      type: 'turn-end',
      key: `turn-end-${currentUser.msg.id}`,
      userItem: currentUser,
      startedAt: currentUser.msg.timestamp,
      completedAt,
      messages: [
        currentUser.msg,
        ...currentSessionItems.flatMap((sectionItem) =>
          sectionItem.type === 'message' ? [sectionItem.msg] : [],
        ),
      ],
    });
  };

  groupedItems.forEach((item, itemIndex) => {
    if (item.type === 'message' && item.msg.role === 'user') {
      appendSessionSummary();
      appendTurnEnd();
      currentUser = item as MessageItem;
      currentSessionItems = [];
    } else if (currentUser) {
      currentSessionItems.push(item);
    }
    rows.push({
      type: 'item',
      key: getItemKey(item),
      item,
      itemIndex,
      sectionId: (currentUser as MessageItem | null)?.msg.id,
    });
  });
  appendSessionSummary();

  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row.type === 'session-summary') {
      rows[i] = { ...row, isLastSection: true };
      break;
    }
  }

  return rows;
}

export function getRowSectionId(row: VirtualRow): string | undefined {
  return row.type === 'item' ? row.sectionId : row.userItem.msg.id;
}

export function getVirtualRowsSignature(virtualRows: VirtualRow[]) {
  return virtualRows.map((row) => row.key).join('\n');
}

export function shouldReserveLeadingStickySpace(
  leadingUserItem: MessageItem | null,
  firstRow: VirtualRow | undefined,
) {
  return Boolean(
    leadingUserItem &&
    firstRow?.type === 'item' &&
    // A loaded window can begin with tools or events as well as text.
    // All need room for the prompt whose original row is outside the window.
    !(firstRow.item.type === 'message' && firstRow.item.msg.role === 'user'),
  );
}

export function buildRowKeyIndexMap(virtualRows: VirtualRow[]) {
  const map = new Map<string, number>();
  virtualRows.forEach((row, index) => map.set(row.key, index));
  return map;
}

export function buildUserRowVirtualIndices(virtualRows: VirtualRow[]) {
  const indices: number[] = [];
  virtualRows.forEach((row, index) => {
    if (row.type === 'item' && row.item.type === 'message' && row.item.msg.role === 'user') {
      indices.push(index);
    }
  });
  return indices;
}

export function buildItemIndexMap(groupedItems: RenderItem[], virtualRows: VirtualRow[]) {
  const groupedIdIndexMap = buildRenderItemIdIndexMap(groupedItems);
  const groupedToVirtualIndex = new Map<number, number>();
  virtualRows.forEach((row, virtualIndex) => {
    if (row.type === 'item') groupedToVirtualIndex.set(row.itemIndex, virtualIndex);
  });

  const map = new Map<string, number>();
  groupedIdIndexMap.forEach((groupedIndex, id) => {
    const virtualIndex = groupedToVirtualIndex.get(groupedIndex);
    if (virtualIndex !== undefined) map.set(id, virtualIndex);
  });
  return map;
}
