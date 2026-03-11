import type { JSONContent } from '@tiptap/react';

export interface SerializedContent {
  text: string;
  fileReferences: { path: string; type: 'file' | 'folder' }[];
  slashCommand?: string;
}

/**
 * Walk TipTap JSON to extract plain text, file references and slash commands.
 *
 * Mention nodes with `attrs.mentionType === 'file'` become `@path` in the text
 * and are collected into `fileReferences`.
 *
 * Mention nodes with `attrs.mentionType === 'slash'` become `/name` in the text
 * and the *first* one encountered is returned as `slashCommand`.
 */
export function serializeEditorContent(json: JSONContent): SerializedContent {
  const fileReferences: SerializedContent['fileReferences'] = [];
  let slashCommand: string | undefined;

  function walk(node: JSONContent): string {
    if (node.type === 'text') return node.text ?? '';
    if (node.type === 'hardBreak') return '\n';

    if (node.type === 'fileMention') {
      const path = (node.attrs?.path as string) ?? (node.attrs?.id as string) ?? '';
      const fileType = (node.attrs?.fileType as 'file' | 'folder') ?? 'file';
      if (path && !fileReferences.some((r) => r.path === path)) {
        fileReferences.push({ path, type: fileType });
      }
      return `@${path}`;
    }

    if (node.type === 'slashCommand') {
      const name = (node.attrs?.id as string) ?? (node.attrs?.label as string) ?? '';
      if (name && !slashCommand) slashCommand = name;
      return `/${name}`;
    }

    if (!node.content) {
      // Paragraph / doc without children → empty
      return node.type === 'paragraph' ? '' : '';
    }

    const inner = node.content.map(walk).join('');

    // Separate paragraphs with newlines
    if (node.type === 'paragraph') return inner;

    // Doc: join paragraphs with \n
    if (node.type === 'doc') {
      return (node.content ?? []).map((child) => walk(child)).join('\n');
    }

    return inner;
  }

  const text = walk(json).trim();
  return { text, fileReferences, slashCommand };
}
