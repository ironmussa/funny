import Mention from '@tiptap/extension-mention';
import { TextSelection } from '@tiptap/pm/state';

export function insertInlineNodeWithTrailingSpace(
  editor: any,
  range: { from: number; to: number },
  typeName: string,
  attrs: Record<string, unknown>,
) {
  const docSize = editor.state.doc.content.size;
  const safeFrom = Math.min(range.from, docSize);
  const safeTo = Math.min(range.to, docSize);
  const nodeType = editor.state.schema.nodes[typeName];
  if (!nodeType) return;

  const node = nodeType.create(attrs);
  const space = editor.state.schema.text(' ');
  const tr = editor.state.tr.replaceWith(safeFrom, safeTo, [node, space]);
  const after = Math.min(safeFrom + node.nodeSize + space.nodeSize, tr.doc.content.size);
  tr.setSelection(TextSelection.create(tr.doc, after));
  editor.view.dispatch(tr);
  editor.view.focus();
}

// Declared at module level: the `this` in addAttributes is not something
// React Compiler can compile inside a component.
export const FileMention = Mention.extend({
  name: 'fileMention',
  addAttributes() {
    return {
      ...this.parent?.(),
      path: { default: null },
      fileType: { default: 'file' },
    };
  },
  renderHTML({ node, HTMLAttributes }) {
    const fileType = node.attrs.fileType || 'file';
    return [
      'span',
      {
        ...HTMLAttributes,
        class: 'file-mention',
        'data-file-type': fileType,
      },
      node.attrs.label || node.attrs.id,
    ];
  },
});

export const SymbolMention = Mention.extend({
  name: 'symbolMention',
  addAttributes() {
    return {
      ...this.parent?.(),
      path: { default: null },
      kind: { default: 'function' },
      line: { default: 0 },
      endLine: { default: null },
    };
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      'span',
      {
        ...HTMLAttributes,
        class: 'symbol-mention',
        'data-symbol-kind': node.attrs.kind || 'function',
      },
      node.attrs.label || node.attrs.id,
    ];
  },
});

/** True for a string value. */
export function isString(value: unknown): value is string {
  return typeof value === 'string';
}
