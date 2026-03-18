import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/api', () => ({ api: { openInEditor: vi.fn() } }));

import { hasEditorUri, toEditorUri, toEditorUriWithLine, getEditorLabel } from '@/lib/editor-utils';
import { useSettingsStore } from '@/stores/settings-store';

beforeEach(() => {
  useSettingsStore.setState({ defaultEditor: 'vscode', useInternalEditor: false });
});

// ── hasEditorUri ─────────────────────────────────────────────────

describe('hasEditorUri', () => {
  test('returns true for vscode', () => {
    expect(hasEditorUri('vscode')).toBe(true);
  });

  test('returns true for cursor', () => {
    expect(hasEditorUri('cursor')).toBe(true);
  });

  test('returns true for windsurf', () => {
    expect(hasEditorUri('windsurf')).toBe(true);
  });

  test('returns true for zed', () => {
    expect(hasEditorUri('zed')).toBe(true);
  });

  test('returns false for sublime', () => {
    expect(hasEditorUri('sublime')).toBe(false);
  });

  test('returns false for vim', () => {
    expect(hasEditorUri('vim')).toBe(false);
  });

  test('uses default editor from store when no arg', () => {
    useSettingsStore.setState({ defaultEditor: 'vim' });
    expect(hasEditorUri()).toBe(false);

    useSettingsStore.setState({ defaultEditor: 'cursor' });
    expect(hasEditorUri()).toBe(true);
  });
});

// ── toEditorUri ──────────────────────────────────────────────────

describe('toEditorUri', () => {
  test('returns vscode URI for vscode editor', () => {
    expect(toEditorUri('/src/file.ts', 'vscode')).toBe('vscode://file/src/file.ts');
  });

  test('returns cursor URI for cursor editor', () => {
    expect(toEditorUri('/src/file.ts', 'cursor')).toBe('cursor://file/src/file.ts');
  });

  test('returns null for sublime', () => {
    expect(toEditorUri('/src/file.ts', 'sublime')).toBeNull();
  });

  test('returns null for vim', () => {
    expect(toEditorUri('/src/file.ts', 'vim')).toBeNull();
  });

  test('returns null when useInternalEditor is true', () => {
    useSettingsStore.setState({ useInternalEditor: true });
    expect(toEditorUri('/src/file.ts', 'vscode')).toBeNull();
  });

  test('normalizes backslashes to forward slashes', () => {
    expect(toEditorUri('C:\\Users\\dev\\file.ts', 'vscode')).toBe(
      'vscode://file/C:/Users/dev/file.ts',
    );
  });

  test('adds leading slash if missing', () => {
    expect(toEditorUri('src/file.ts', 'vscode')).toBe('vscode://file/src/file.ts');
  });

  test('preserves leading slash', () => {
    expect(toEditorUri('/src/file.ts', 'vscode')).toBe('vscode://file/src/file.ts');
  });
});

// ── toEditorUriWithLine ──────────────────────────────────────────

describe('toEditorUriWithLine', () => {
  test('parses line number from path:line format', () => {
    expect(toEditorUriWithLine('/src/file.ts:42', 'vscode')).toBe('vscode://file/src/file.ts:42');
  });

  test('handles path without line number', () => {
    expect(toEditorUriWithLine('/src/file.ts', 'vscode')).toBe('vscode://file/src/file.ts');
  });

  test('returns null for editors without URI scheme', () => {
    expect(toEditorUriWithLine('/src/file.ts:42', 'sublime')).toBeNull();
  });

  test('returns null when useInternalEditor is true', () => {
    useSettingsStore.setState({ useInternalEditor: true });
    expect(toEditorUriWithLine('/src/file.ts:42', 'vscode')).toBeNull();
  });
});

// ── getEditorLabel ───────────────────────────────────────────────

describe('getEditorLabel', () => {
  test('returns "Cursor" for cursor', () => {
    expect(getEditorLabel('cursor')).toBe('Cursor');
  });

  test('returns "VS Code" for vscode', () => {
    expect(getEditorLabel('vscode')).toBe('VS Code');
  });

  test('returns label for default editor when no arg', () => {
    useSettingsStore.setState({ defaultEditor: 'zed' });
    expect(getEditorLabel()).toBe('Zed');
  });
});
