## Why

Loading a project in the native GPUIX client increases frame paint time by roughly 15 ms because the file manager retains a fixed 96-row window with generous overdraw, even when the viewport can display far fewer rows. The renderer benchmark currently omits a populated project tree, so this user-visible cost is not represented by the performance gate.

## What Changes

- Size the retained native file-tree window from the measured viewport height, with a small bounded overscan instead of a fixed 96-row allocation.
- Preserve scroll anchoring and keyboard/mouse behavior while reducing off-screen native rows and avoiding avoidable row reconstruction.
- Extend renderer benchmark fixtures and diagnostics with a populated project tree so project-selection paint cost is reproducible.
- Add regression coverage for retained-window bounds, scrolling, and populated-tree benchmark evidence.

## Capabilities

### New Capabilities

- `gpuix-file-manager-performance`: Defines bounded viewport-aware native file-tree rendering and representative benchmark coverage for populated projects.

### Modified Capabilities

None.

## Impact

- Affects `packages/gpuix-ui` file-tree rendering and tests.
- Affects the GPUIX product benchmark fixture, automation diagnostics, and renderer benchmark documentation.
- Does not change server APIs, persisted data, or web-client file-manager behavior.
