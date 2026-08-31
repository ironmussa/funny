export const MESSAGE_CONTENT_COLLAPSED_CHARACTERS = 400;
export const MESSAGE_CONTENT_COLLAPSED_LINES = 12;
export const MESSAGE_CONTENT_EXPANDED_CHARACTERS = 4_000;

export interface MessageContentPreview {
  content: string;
  remainingCharacters: number;
  visibleCharacters: number;
}

export function createMessageContentPreview(
  content: string,
  requestedCharacters = MESSAGE_CONTENT_COLLAPSED_CHARACTERS,
): MessageContentPreview {
  const visibleCharacters = Math.min(content.length, Math.max(0, Math.floor(requestedCharacters)));
  return {
    content: visibleCharacters === content.length ? content : content.slice(0, visibleCharacters),
    remainingCharacters: content.length - visibleCharacters,
    visibleCharacters,
  };
}

export function nextMessageContentPreviewLength(current: number, total: number): number {
  if (current < MESSAGE_CONTENT_EXPANDED_CHARACTERS) {
    return Math.min(total, MESSAGE_CONTENT_EXPANDED_CHARACTERS);
  }
  return Math.min(total, current * 2);
}
