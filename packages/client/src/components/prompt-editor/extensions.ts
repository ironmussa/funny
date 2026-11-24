import Document from '@tiptap/extension-document';
import HardBreak from '@tiptap/extension-hard-break';
import History from '@tiptap/extension-history';
import Mention, { type MentionOptions } from '@tiptap/extension-mention';
import Paragraph from '@tiptap/extension-paragraph';
import Placeholder from '@tiptap/extension-placeholder';
import Text from '@tiptap/extension-text';
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
const FileMention = Mention.extend({
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

const SymbolMention = Mention.extend({
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

type SuggestionConfig = MentionOptions['suggestion'];

interface PromptEditorSuggestions {
  file: SuggestionConfig;
  slash: SuggestionConfig;
  workflow: SuggestionConfig;
  symbol: SuggestionConfig;
}

/**
 * The editor's extension list. Built on every render, like the inline list it
 * replaces, so each trigger's suggestion config is the current one.
 */
export function buildPromptEditorExtensions(
  placeholder: string | undefined,
  suggestions: PromptEditorSuggestions,
) {
  return [
    Document,
    Paragraph,
    Text,
    HardBreak,
    History,
    // Keep the hint visible while disabled (e.g. the prompt dock shown
    // during thread preparation), not just while editable.
    Placeholder.configure({ placeholder: placeholder ?? '', showOnlyWhenEditable: false }),
    // File mentions (@ trigger)
    FileMention.configure({
      HTMLAttributes: { class: 'file-mention' },
      suggestion: suggestions.file,
      deleteTriggerWithBackspace: true,
    }),
    // Slash commands (/ trigger)
    Mention.extend({
      name: 'slashCommand',
      renderHTML({ node, HTMLAttributes }) {
        return [
          'span',
          {
            ...HTMLAttributes,
            class: 'slash-command',
          },
          node.attrs.label || node.attrs.id,
        ];
      },
    }).configure({
      HTMLAttributes: { class: 'slash-command' },
      suggestion: suggestions.slash,
      deleteTriggerWithBackspace: true,
    }),
    // Workflow invocations (>> trigger)
    Mention.extend({
      name: 'workflowInvocation',
    }).configure({
      suggestion: suggestions.workflow,
      deleteTriggerWithBackspace: true,
    }),
    // Symbol mentions (# trigger)
    SymbolMention.configure({
      HTMLAttributes: { class: 'symbol-mention' },
      suggestion: suggestions.symbol,
      deleteTriggerWithBackspace: true,
    }),
  ];
}
