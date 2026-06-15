import { okAsync } from 'neverthrow';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { systemApi } from '@/lib/api/system';
import {
  __resetVisualizerRegistry,
  registerVisualizer,
  type VisualizerPlugin,
} from '@/lib/visualizer-registry';
import { useInternalEditorStore } from '@/stores/internal-editor-store';

const NOOP: VisualizerPlugin['Component'] = () => null;

beforeEach(() => {
  __resetVisualizerRegistry();
  useInternalEditorStore.getState().closeEditor();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('openBinaryFile', () => {
  test('opens the dialog without fetching text content', () => {
    useInternalEditorStore.getState().openBinaryFile('/abs/data.parquet');
    const s = useInternalEditorStore.getState();
    expect(s.isOpen).toBe(true);
    expect(s.filePath).toBe('/abs/data.parquet');
    // No text read — content stays empty so binary bytes are never decoded.
    expect(s.initialContent).toBe('');
  });
});

describe('openFileInInternalEditor binary routing', () => {
  test('a file claimed by a binary visualizer opens with no text content', async () => {
    // If the text path were taken, readFile would run — make it observable.
    const readFile = vi.spyOn(systemApi, 'readFile');
    registerVisualizer({
      id: 'test/parquet',
      version: '1.0.0',
      contributes: { fileExtensions: ['.parquet'], binary: true },
      Component: NOOP,
    });

    const { openFileInInternalEditor } = await import('@/lib/editor-utils');
    openFileInInternalEditor('/abs/data.parquet');

    await vi.waitFor(() => {
      const s = useInternalEditorStore.getState();
      expect(s.isOpen).toBe(true);
      expect(s.filePath).toBe('/abs/data.parquet');
    });
    // Binary path: empty content, and the text endpoint was never hit.
    expect(useInternalEditorStore.getState().initialContent).toBe('');
    expect(readFile).not.toHaveBeenCalled();
  });

  test('a non-binary file falls back to the text editor path', async () => {
    const readFile = vi
      .spyOn(systemApi, 'readFile')
      .mockReturnValue(okAsync({ content: 'hello world' }));

    const { openFileInInternalEditor } = await import('@/lib/editor-utils');
    openFileInInternalEditor('/abs/notes.ts');

    await vi.waitFor(() => {
      expect(readFile).toHaveBeenCalledWith('/abs/notes.ts');
      // Text path loaded the fetched content (binary path would leave it '').
      expect(useInternalEditorStore.getState().initialContent).toBe('hello world');
    });
  });
});
