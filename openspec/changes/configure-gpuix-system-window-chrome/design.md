## Context

The GPUIX native module chooses its Linux display backend while it is loaded. The current entry point already dynamically imports the module that imports `@gpuix/react`, which provides a safe boundary for applying a Linux-only environment override first. GPUIX 0.5.1 exposes window initialization options but no public imperative close, maximize, minimize, or drag API.

## Goals / Non-Goals

**Goals:**

- Keep the current Linux client visible while adding the native capabilities required for Wayland client-side window controls.
- Keep startup correct on macOS and Windows with no Linux display variables injected.
- Keep backend parsing deterministic and independently testable.

**Non-Goals:**

- Implement custom client-side title-bar buttons.
- Guarantee decorations under Linux compositors that decline server-side Wayland decorations.
- Change GPUIX versions or native bindings.

## Decisions

### Use an application-scoped backend preference

Add `FUNNY_GPUIX_LINUX_BACKEND=auto|x11|wayland` instead of asking users to persist `WAYLAND_DISPLAY`. An application-scoped variable is self-documenting and can be present harmlessly in a shared `.env` on every platform. Directly documenting `WAYLAND_DISPLAY=` was rejected because it leaks a Linux implementation detail and could affect unrelated child processes.

### Apply the override before importing the renderer

Parse and apply the preference in the lightweight GPUIX entry point, then dynamically import the native renderer. For Linux `x11`, set `WAYLAND_DISPLAY` to an empty string in the current process. `auto` and `wayland` preserve the inherited environment because fabricating a Wayland socket name would be unsafe. macOS and Windows never mutate `WAYLAND_DISPLAY`.

### Use host chrome instead of custom controls

Initialize a titled, opaque, resizable window with minimum dimensions and leave the native title bar enabled on macOS and Windows. Linux Wayland requires a React-built title bar backed by new GPUIX Rust bindings for `WindowControlArea::{Drag, Min, Max, Close}` and maximized state. The published 0.5.1 binding cannot support those controls by configuration alone.

### Keep the repository template portable

Document the setting in `.env.example` and set it in the ignored local `.env` requested by the user. The example uses `auto` because the published Linux binary becomes headless when X11 is forced, while explaining that the key has no effect on macOS and Windows.

## Risks / Trade-offs

- [The published binary does not open an X11 connection] → Default to `auto` and do not recommend `x11` until Funny ships a rebuilt binding.
- [Wayland remains undecorated] → Extend GPUIX with window-control areas and render a client-side Linux title bar.
- [Environment is read after native module load] → Keep the renderer import dynamic and cover configuration parsing with unit tests.

## Migration Plan

Add the preference and parser without changing persisted application state. Rollback consists of removing the preference or setting it to `auto`; no data migration is required.
