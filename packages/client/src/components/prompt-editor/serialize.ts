import type { JSONContent } from '@tiptap/react';

export interface SymbolReference {
  path: string;
  name: string;
  kind: string;
  line: number;
  endLine?: number;
}

export interface SerializedContent {
  text: string;
  fileReferences: { path: string; type: 'file' | 'folder' }[];
  symbolReferences: SymbolReference[];
  slashCommand?: string;
}

/**
 * Walk TipTap JSON to extract plain text, file references, symbol references,
 * and slash commands.
 *
 * Mention nodes with `attrs.mentionType === 'file'` become `@path` in the text
 * and are collected into `fileReferences`.
 *
 * Mention nodes of type `symbolMention` become `#path:name` in the text
 * and are collected into `symbolReferences`.
 *
 * Mention nodes with `attrs.mentionType === 'slash'` become `/name` in the text
 * and the *first* one encountered is returned as `slashCommand`.
 */
export function serializeEditorContent(json: JSONContent): SerializedContent {
  const fileReferences: SerializedContent['fileReferences'] = [];
  const symbolReferences: SymbolReference[] = [];
  let slashCommand: string | undefined;

  function walk(node: JSONContent): string {
    if (node.type === 'text') return node.text ?? '';
    if (node.type === 'hardBreak') return '\n';

    if (node.type === 'fileMention') {
      // SAFETY: PromptEditor creates fileMention nodes with a string id and path; path
      // defaults to null, which the ?? chain replaces.
      const path = (node.attrs?.path as string) ?? (node.attrs?.id as string) ?? '';
      // SAFETY: fileType is set from a browse result or drag data, both 'file' | 'folder',
      // and defaults to 'file'.
      const fileType = (node.attrs?.fileType as 'file' | 'folder') ?? 'file';
      if (path && !fileReferences.some((r) => r.path === path)) {
        fileReferences.push({ path, type: fileType });
      }
      return `@${path}`;
    }

    if (node.type === 'symbolMention') {
      // SAFETY: PromptEditor creates symbolMention nodes with a string path (default null,
      // replaced by '').
      const path = (node.attrs?.path as string) ?? '';
      // SAFETY: label and id are the symbol search result's string fields.
      const name = (node.attrs?.label as string) ?? (node.attrs?.id as string) ?? '';
      // SAFETY: kind is the symbol result's string kind, or the 'function' default.
      const kind = (node.attrs?.kind as string) ?? 'function';
      // SAFETY: line is the symbol result's numeric line, or the 0 default.
      const line = (node.attrs?.line as number) ?? 0;
      // SAFETY: endLine is the symbol result's numeric end line; without one the attribute
      // holds its null default, which is falsy like undefined.
      const endLine = node.attrs?.endLine as number | undefined;
      if (path && name && !symbolReferences.some((r) => r.path === path && r.name === name)) {
        symbolReferences.push({ path, name, kind, line, endLine });
      }
      return `#${path}:${name}`;
    }

    if (node.type === 'slashCommand') {
      // SAFETY: PromptEditor creates slashCommand nodes with the suggestion item's string
      // id and label.
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
  return { text, fileReferences, symbolReferences, slashCommand };
}
