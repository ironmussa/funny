import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock browser globals BEFORE importing the store (it accesses them at module level)
vi.stubGlobal('document', {
  documentElement: { classList: { toggle: vi.fn() } },
});
vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
  matches: false,
  addEventListener: vi.fn(),
}));

import {
  deriveToolLists,
  ALL_STANDARD_TOOLS,
  TOOL_LABELS,
  editorLabels,
  useSettingsStore,
} from '@/stores/settings-store';
import type { ToolPermission } from '@funny/shared';

describe('SettingsStore', () => {
  beforeEach(() => {
    // Reset store to default state before each test
    useSettingsStore.setState({
      theme: 'dark',
      defaultEditor: 'cursor',
      toolPermissions: Object.fromEntries(
        ALL_STANDARD_TOOLS.map(tool => [tool, 'allow' as ToolPermission])
      ),
      setupCompleted: false,
    });
    vi.clearAllMocks();
  });

  // ── deriveToolLists ──────────────────────────────────────────────

  describe('deriveToolLists', () => {
    test('with all allow returns all in allowedTools', () => {
      const permissions: Record<string, ToolPermission> = Object.fromEntries(
        ALL_STANDARD_TOOLS.map(tool => [tool, 'allow' as ToolPermission])
      );

      const { allowedTools, disallowedTools } = deriveToolLists(permissions);

      expect(allowedTools).toEqual([...ALL_STANDARD_TOOLS]);
      expect(disallowedTools).toEqual([]);
    });

    test('with all deny returns all in disallowedTools', () => {
      const permissions: Record<string, ToolPermission> = Object.fromEntries(
        ALL_STANDARD_TOOLS.map(tool => [tool, 'deny' as ToolPermission])
      );

      const { allowedTools, disallowedTools } = deriveToolLists(permissions);

      expect(allowedTools).toEqual([]);
      expect(disallowedTools).toEqual([...ALL_STANDARD_TOOLS]);
    });

    test('with ask puts tool in neither list', () => {
      const permissions: Record<string, ToolPermission> = {
        Read: 'ask',
        Edit: 'ask',
      };

      const { allowedTools, disallowedTools } = deriveToolLists(permissions);

      expect(allowedTools).toEqual([]);
      expect(disallowedTools).toEqual([]);
    });

    test('with mixed permissions sorts tools correctly', () => {
      const permissions: Record<string, ToolPermission> = {
        Read: 'allow',
        Edit: 'deny',
        Write: 'ask',
        Bash: 'allow',
        Glob: 'deny',
      };

      const { allowedTools, disallowedTools } = deriveToolLists(permissions);

      expect(allowedTools).toEqual(['Read', 'Bash']);
      expect(disallowedTools).toEqual(['Edit', 'Glob']);
    });
  });

  // ── Constants ────────────────────────────────────────────────────

  describe('ALL_STANDARD_TOOLS', () => {
    test('contains expected tools', () => {
      expect(ALL_STANDARD_TOOLS).toContain('Read');
      expect(ALL_STANDARD_TOOLS).toContain('Edit');
      expect(ALL_STANDARD_TOOLS).toContain('Write');
      expect(ALL_STANDARD_TOOLS).toContain('Bash');
      expect(ALL_STANDARD_TOOLS).toContain('Glob');
      expect(ALL_STANDARD_TOOLS).toContain('Grep');
      expect(ALL_STANDARD_TOOLS).toContain('WebSearch');
      expect(ALL_STANDARD_TOOLS).toContain('WebFetch');
      expect(ALL_STANDARD_TOOLS).toContain('Task');
      expect(ALL_STANDARD_TOOLS).toContain('TodoWrite');
      expect(ALL_STANDARD_TOOLS).toContain('NotebookEdit');
      expect(ALL_STANDARD_TOOLS).toHaveLength(11);
    });
  });

  describe('TOOL_LABELS', () => {
    test('has entries for all standard tools', () => {
      for (const tool of ALL_STANDARD_TOOLS) {
        expect(TOOL_LABELS).toHaveProperty(tool);
        expect(typeof TOOL_LABELS[tool]).toBe('string');
        expect(TOOL_LABELS[tool].length).toBeGreaterThan(0);
      }
    });
  });

  describe('editorLabels', () => {
    test('has expected editors', () => {
      expect(editorLabels).toEqual({
        cursor: 'Cursor',
        vscode: 'VS Code',
        windsurf: 'Windsurf',
        zed: 'Zed',
        sublime: 'Sublime Text',
        vim: 'Vim',
      });
    });
  });

  // ── Store defaults ───────────────────────────────────────────────

  describe('Store defaults', () => {
    test('has correct default values', () => {
      const state = useSettingsStore.getState();

      expect(state.theme).toBe('dark');
      expect(state.defaultEditor).toBe('cursor');
      expect(state.setupCompleted).toBe(false);

      // All tool permissions default to 'allow'
      for (const tool of ALL_STANDARD_TOOLS) {
        expect(state.toolPermissions[tool]).toBe('allow');
      }
    });
  });

  // ── Actions ──────────────────────────────────────────────────────

  describe('setDefaultEditor', () => {
    test('updates editor', () => {
      useSettingsStore.getState().setDefaultEditor('vscode');
      expect(useSettingsStore.getState().defaultEditor).toBe('vscode');
    });
  });

  describe('setToolPermission', () => {
    test('updates a single tool permission', () => {
      useSettingsStore.getState().setToolPermission('Bash', 'deny');

      const state = useSettingsStore.getState();
      expect(state.toolPermissions['Bash']).toBe('deny');
      // Other tools remain unchanged
      expect(state.toolPermissions['Read']).toBe('allow');
      expect(state.toolPermissions['Edit']).toBe('allow');
    });
  });

  describe('resetToolPermissions', () => {
    test('resets all to default (allow)', () => {
      // First change some permissions
      useSettingsStore.getState().setToolPermission('Bash', 'deny');
      useSettingsStore.getState().setToolPermission('Read', 'ask');
      useSettingsStore.getState().setToolPermission('Edit', 'deny');

      // Reset
      useSettingsStore.getState().resetToolPermissions();

      const state = useSettingsStore.getState();
      for (const tool of ALL_STANDARD_TOOLS) {
        expect(state.toolPermissions[tool]).toBe('allow');
      }
    });
  });

  describe('completeSetup', () => {
    test('sets setupCompleted to true', () => {
      expect(useSettingsStore.getState().setupCompleted).toBe(false);

      useSettingsStore.getState().completeSetup();

      expect(useSettingsStore.getState().setupCompleted).toBe(true);
    });
  });
});
