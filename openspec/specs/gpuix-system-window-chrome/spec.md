# gpuix-system-window-chrome Specification

## Purpose
Defines how the native GPUIX client obtains usable system window controls while preserving host-appropriate behavior across Linux, macOS, and Windows.

## Requirements

### Requirement: Host-native window chrome

The GPUIX client SHALL create a titled, resizable native window with host-provided close, maximize, and minimize controls wherever the selected host backend supplies them.

#### Scenario: Native controls on macOS and Windows

- **WHEN** the GPUIX client starts on macOS or Windows
- **THEN** it uses the platform's native system window chrome without applying Linux display-server overrides

#### Scenario: Client-side controls on Linux Wayland

- **WHEN** the GPUIX client starts on Linux Wayland
- **THEN** Funny supplies a draggable title bar and close, maximize/restore, and minimize controls through native GPUI window-control areas

### Requirement: Linux backend preference

The GPUIX client SHALL accept `auto`, `x11`, and `wayland` through `FUNNY_GPUIX_LINUX_BACKEND`, SHALL default missing or invalid values to `auto`, and SHALL apply the preference only on Linux.

#### Scenario: X11 is selected on Linux

- **WHEN** `FUNNY_GPUIX_LINUX_BACKEND` is `x11` on Linux
- **THEN** the client disables Wayland selection before loading the native renderer
- **AND** documentation warns that the published GPUIX 0.5.1 Linux binary falls back to a headless host in this mode

#### Scenario: Automatic or Wayland backend is selected

- **WHEN** the preference is `auto`, `wayland`, missing, or invalid
- **THEN** the client preserves the inherited display-server environment

#### Scenario: Linux preference exists on another host

- **WHEN** `FUNNY_GPUIX_LINUX_BACKEND` is set on macOS or Windows
- **THEN** the client does not mutate the host display environment

### Requirement: Portable environment documentation

The repository SHALL document the Linux backend preference in its environment template and SHALL make clear that macOS and Windows retain their native behavior.

#### Scenario: Developer configures a checkout

- **WHEN** a developer copies or reads the root environment template
- **THEN** the available backend values, Linux-only scope, and cross-platform behavior are discoverable
