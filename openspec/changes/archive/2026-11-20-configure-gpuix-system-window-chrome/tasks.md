## 1. Backend Configuration

- [x] 1.1 Add and document the portable `FUNNY_GPUIX_LINUX_BACKEND` setting in the root environment files
- [x] 1.2 Implement validated, Linux-only backend environment configuration before native renderer loading

## 2. Native Window Chrome

- [x] 2.1 Configure the GPUIX window with a native title bar, application identity, resizing, and minimum dimensions
- [x] 2.2 Document Linux X11/XWayland behavior and native macOS/Windows behavior

## 3. Verification

- [x] 3.1 Add unit coverage for Linux, macOS, Windows, missing, and invalid backend preferences
- [x] 3.2 Run focused tests, OpenSpec validation, lint, and typecheck

## 4. Runtime Investigation

- [x] 4.1 Confirm from the live process and system window tree that the current client remains on Wayland
- [x] 4.2 Trace an X11-forced launch and confirm the published GPUIX Linux binary opens no X11 connection and falls back to a headless host
- [ ] 4.3 Extend the GPUIX Rust binding with Linux client-side window controls and produce native binaries for Linux, macOS, and Windows
