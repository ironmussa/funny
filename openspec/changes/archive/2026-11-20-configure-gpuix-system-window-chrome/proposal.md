## Why

The GPUIX client opens without usable system window controls on Linux Wayland. Runtime tracing also showed that forcing the published GPUIX 0.5.1 Linux binary to X11 opens no X11 connection and falls back to a headless host. Funny therefore needs client-side Linux controls in the native binding while preserving native macOS and Windows behavior.

## What Changes

- Add a `FUNNY_GPUIX_LINUX_BACKEND` environment preference with `auto`, `x11`, and `wayland` modes.
- Default the local `.env` example and current development environment to `auto`, keeping the published Linux binary visible on Wayland.
- Apply the backend override only on Linux; macOS and Windows continue using their native window chrome without Linux-specific environment mutations.
- Give the GPUIX window an application title, resizable system frame, and minimum dimensions on every supported platform.
- Document the portability behavior and add unit coverage for Linux, macOS, Windows, invalid values, and the default mode.

## Capabilities

### New Capabilities

- `gpuix-system-window-chrome`: Defines portable GPUIX system-window configuration and Linux backend selection.

### Modified Capabilities

None.

## Impact

- Affects GPUIX startup, native window initialization, root environment examples, and GPUIX client documentation/tests.
- Does not change web renderer behavior, server APIs, persisted data, or dependencies.
- Linux `x11` mode remains unavailable with the published GPUIX 0.5.1 binary; macOS and Windows ignore the Linux-only preference.
