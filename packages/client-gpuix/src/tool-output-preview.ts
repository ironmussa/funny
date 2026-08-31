export const TOOL_OUTPUT_COLLAPSED_CHARACTERS = 240;
export const TOOL_OUTPUT_COLLAPSED_LINES = 6;
export const TOOL_OUTPUT_EXPANDED_CHARACTERS = 2_000;

export interface ToolOutputPreview {
  content: string;
  remainingCharacters: number;
  visibleCharacters: number;
}

export function createToolOutputPreview(
  content: string,
  requestedCharacters = TOOL_OUTPUT_COLLAPSED_CHARACTERS,
): ToolOutputPreview {
  const visibleCharacters = Math.min(content.length, Math.max(0, Math.floor(requestedCharacters)));
  return {
    content: visibleCharacters === content.length ? content : content.slice(0, visibleCharacters),
    remainingCharacters: content.length - visibleCharacters,
    visibleCharacters,
  };
}

export function nextToolOutputPreviewLength(current: number, total: number): number {
  if (current < TOOL_OUTPUT_EXPANDED_CHARACTERS) {
    return Math.min(total, TOOL_OUTPUT_EXPANDED_CHARACTERS);
  }
  return Math.min(total, current * 2);
}
