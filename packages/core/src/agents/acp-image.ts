/**
 * Helpers for forwarding image attachments through ACP-based adapters
 * (gemini-acp, codex-acp, deepagents, and Pi SDK).
 *
 * funny stores image attachments in the Anthropic API shape internally
 * (`{ type:'image', source:{ type:'base64', media_type, data } }`) — see
 * `ImageAttachment` in `packages/shared/src/types.ts`. ACP uses a flatter
 * `ImageContent` shape (`{ type:'image', data, mimeType }`). This module
 * converts between the two and is tolerant of either input form.
 */

export type ACPImageBlock = {
  type: 'image';
  data: string;
  mimeType: string;
};

export function toACPImageBlocks(images: unknown): ACPImageBlock[] {
  if (!Array.isArray(images) || images.length === 0) return [];
  const blocks: ACPImageBlock[] = [];
  for (const img of images) {
    const src = (img as any)?.source;
    const data: string | undefined = src?.data ?? (img as any)?.data;
    const mimeType: string | undefined = src?.media_type ?? (img as any)?.mimeType;
    if (typeof data === 'string' && typeof mimeType === 'string') {
      blocks.push({ type: 'image', data, mimeType });
    }
  }
  return blocks;
}
