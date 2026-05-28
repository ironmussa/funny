import { describe, test, expect, beforeEach } from 'vitest';

import { useDraftStore } from '@/stores/draft-store';

describe('useDraftStore', () => {
  beforeEach(() => {
    useDraftStore.setState({ drafts: {} });
  });

  describe('setEditorDraft', () => {
    const emptyDoc = { type: 'doc', content: [{ type: 'paragraph' }] };
    const nonEmptyDoc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }],
    };

    test('stores TipTap editor content and clears legacy prompt fields', () => {
      useDraftStore.getState().setPromptDraft('t1', 'legacy', [], []);
      useDraftStore.getState().setEditorDraft('t1', nonEmptyDoc, []);

      const draft = useDraftStore.getState().drafts['t1'];
      expect(draft.editorContent).toEqual(nonEmptyDoc);
      expect(draft.prompt).toBeUndefined();
      expect(draft.selectedFiles).toBeUndefined();
    });

    test('removes draft entry when editor content and images are empty', () => {
      useDraftStore.getState().setEditorDraft('t1', nonEmptyDoc, []);
      useDraftStore.getState().setEditorDraft('t1', emptyDoc, []);

      expect(useDraftStore.getState().drafts['t1']).toBeUndefined();
    });

    test('keeps commit draft when clearing empty editor content', () => {
      useDraftStore.getState().setEditorDraft('t1', nonEmptyDoc, []);
      useDraftStore.getState().setCommitDraft('t1', 'title', 'body');
      useDraftStore.getState().setEditorDraft('t1', emptyDoc, []);

      expect(useDraftStore.getState().drafts['t1']).toMatchObject({
        commitTitle: 'title',
        commitBody: 'body',
      });
    });
  });

  describe('setPromptDraft', () => {
    test('stores prompt, images, and selectedFiles', () => {
      const images = [
        {
          type: 'image' as const,
          source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'abc' },
        },
      ];
      const files = ['/path/to/file.ts'];

      useDraftStore.getState().setPromptDraft('t1', 'hello', images, files);

      const draft = useDraftStore.getState().drafts['t1'];
      expect(draft.prompt).toBe('hello');
      expect(draft.images).toEqual(images);
      expect(draft.selectedFiles).toEqual(files);
    });

    test('with empty values clears draft entry', () => {
      // First set a prompt draft
      useDraftStore.getState().setPromptDraft('t1', 'hello', [], ['/file.ts']);
      expect(useDraftStore.getState().drafts['t1']).toBeDefined();

      // Now set with empty values — should remove the entry entirely
      useDraftStore.getState().setPromptDraft('t1', '', [], []);
      expect(useDraftStore.getState().drafts['t1']).toBeUndefined();
    });

    test('with empty values keeps commit draft if present', () => {
      // Set both prompt and commit drafts
      useDraftStore.getState().setPromptDraft('t1', 'hello', [], []);
      useDraftStore.getState().setCommitDraft('t1', 'fix bug', 'details');

      // Clear prompt with empty values
      useDraftStore.getState().setPromptDraft('t1', '', [], []);

      const draft = useDraftStore.getState().drafts['t1'];
      expect(draft).toBeDefined();
      expect(draft.prompt).toBeUndefined();
      expect(draft.commitTitle).toBe('fix bug');
      expect(draft.commitBody).toBe('details');
    });
  });

  describe('setCommitDraft', () => {
    test('stores title and body', () => {
      useDraftStore.getState().setCommitDraft('t1', 'fix: bug', 'Fixed the thing');

      const draft = useDraftStore.getState().drafts['t1'];
      expect(draft.commitTitle).toBe('fix: bug');
      expect(draft.commitBody).toBe('Fixed the thing');
    });

    test('with empty values clears draft entry', () => {
      useDraftStore.getState().setCommitDraft('t1', 'title', 'body');
      expect(useDraftStore.getState().drafts['t1']).toBeDefined();

      useDraftStore.getState().setCommitDraft('t1', '', '');
      expect(useDraftStore.getState().drafts['t1']).toBeUndefined();
    });

    test('with empty values keeps prompt draft if present', () => {
      useDraftStore.getState().setPromptDraft('t1', 'hello', [], ['/file.ts']);
      useDraftStore.getState().setCommitDraft('t1', 'title', 'body');

      // Clear commit with empty values
      useDraftStore.getState().setCommitDraft('t1', '', '');

      const draft = useDraftStore.getState().drafts['t1'];
      expect(draft).toBeDefined();
      expect(draft.commitTitle).toBeUndefined();
      expect(draft.commitBody).toBeUndefined();
      expect(draft.prompt).toBe('hello');
    });
  });

  describe('clearPromptDraft', () => {
    test('removes prompt fields but keeps commit fields', () => {
      useDraftStore.getState().setPromptDraft('t1', 'hello', [], ['/file.ts']);
      useDraftStore.getState().setCommitDraft('t1', 'title', 'body');

      useDraftStore.getState().clearPromptDraft('t1');

      const draft = useDraftStore.getState().drafts['t1'];
      expect(draft).toBeDefined();
      expect(draft.prompt).toBeUndefined();
      expect(draft.images).toBeUndefined();
      expect(draft.selectedFiles).toBeUndefined();
      expect(draft.commitTitle).toBe('title');
      expect(draft.commitBody).toBe('body');
    });

    test('removes entire entry when no other fields exist', () => {
      useDraftStore.getState().setPromptDraft('t1', 'hello', [], ['/file.ts']);

      useDraftStore.getState().clearPromptDraft('t1');

      expect(useDraftStore.getState().drafts['t1']).toBeUndefined();
    });

    test('is no-op for non-existent threadId', () => {
      useDraftStore.getState().clearPromptDraft('nonexistent');
      expect(useDraftStore.getState().drafts).toEqual({});
    });
  });

  describe('clearCommitDraft', () => {
    test('removes commit fields but keeps prompt fields', () => {
      useDraftStore.getState().setPromptDraft('t1', 'hello', [], ['/file.ts']);
      useDraftStore.getState().setCommitDraft('t1', 'title', 'body');

      useDraftStore.getState().clearCommitDraft('t1');

      const draft = useDraftStore.getState().drafts['t1'];
      expect(draft).toBeDefined();
      expect(draft.commitTitle).toBeUndefined();
      expect(draft.commitBody).toBeUndefined();
      expect(draft.prompt).toBe('hello');
    });

    test('removes entire entry when no other fields exist', () => {
      useDraftStore.getState().setCommitDraft('t1', 'title', 'body');

      useDraftStore.getState().clearCommitDraft('t1');

      expect(useDraftStore.getState().drafts['t1']).toBeUndefined();
    });
  });
});
