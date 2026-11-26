import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import * as esbuild from 'esbuild';

import { actions, registerContentActions, type ContentActions } from '../src/content/actions';

const noop = () => {};

function fakeActions(): ContentActions {
  return {
    copyScreenshotToClipboard: async () => {},
    deactivate: noop,
    hideHistoryPanel: noop,
    hidePopover: noop,
    hideSettingsPanel: noop,
    positionPopoverAtPoint: noop,
    sendToFunny: async () => {},
    showPopoverForEdit: noop,
    toggleBrowseMode: noop,
    updateToolbarCount: noop,
    updateToolbarProjectName: noop,
  };
}

describe('content actions registry', () => {
  test('returns the functions the entry point registered', () => {
    const fns = fakeActions();
    registerContentActions(fns);
    expect(actions()).toBe(fns);
  });
});

describe('content script bundle', () => {
  test('bundles content.ts and its modules into one IIFE without imports', async () => {
    const result = await esbuild.build({
      entryPoints: [join(import.meta.dir, '../src/content.ts')],
      bundle: true,
      target: 'chrome120',
      format: 'iife',
      write: false,
    });
    const code = result.outputFiles[0].text;
    expect(result.errors).toEqual([]);
    expect(code).not.toMatch(/^\s*(import|export)\s/m);
    // Every back-edge used by the extracted modules is registered by the entry point.
    expect(code).toContain('registerContentActions({');
    expect(code).toContain('throw new Error("Funny Annotator already active")');
  });
});
