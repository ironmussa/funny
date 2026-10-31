# GPUIX product-client readiness

Audited on 2026-10-31 against the npm registry, installed declarations, and published package
metadata. The production client pins `@gpuix/react` and `@gpuix/native` to the same exact version,
`0.11.0`, as upstream requires since `0.9.0`. The upgrade from `0.5.1` brings the cheaper commit and
idle-frame paths, accessibility props, native scrollbars, and border-box `getElementBounds()`, which
now returns `{ x, y, width, height }` instead of an array.

## Candidate native matrix

The native package publishes optional binaries for macOS arm64/x64, glibc Linux arm64/x64, and
Windows arm64/x64. A target remains a release candidate until Funny's native product smoke passes on
that target. Linux musl is unsupported because no musl binary is published.

Release-smoke status:

- glibc Linux x64: passed locally on 2026-08-24 with `0.5.1`; the live client was launched on
  `0.11.0` on 2026-10-31, and the release-tarball smoke must be re-run before shipping.
- glibc Linux arm64, macOS arm64/x64, and Windows arm64/x64: binary published, but Funny release
  smoke not executed in this handoff.
- Linux musl: unsupported because GPUIX 0.11.0 publishes no compatible binary.

`@gpuix/react` accepts React 18 or 19. Funny uses the workspace React 19 instance and externalizes
React plus GPUIX packages from the product bundle to prevent a duplicate reconciler runtime.

## Public telemetry

The production renderer exposes automation trees, last-painted bounds, painted text, screenshots,
and aggregate debug-overlay statistics (`current`, `p90`, `p99`, `max`, and frame count). Funny
keeps the native overlay hidden for normal product launches and enables it together with renderer
warnings and product debug actions only when `FUNNY_GPUIX_DIAGNOSTICS=true`. Controlled benchmark
entry points enable the overlay explicitly and reset its samples before collection. GPUIX does not
expose the underlying raw samples or a verified presented-frame timestamp. The automation protocol
declares a `frame` event, but the published server implementation does not emit it.

The overlay statistics are valid diagnostics for native draw cost, but mutation completion, `tick()`
duration, timers, and overlay values remain invalid substitutes for input-to-present latency. Product
acceptance must keep presentation metrics explicitly unsupported until a later pinned public API
provides a verifiable presentation boundary.

GPUIX 0.11.0 exposes accessibility through `role` and `aria-*` props (AccessKit). The shared
`gpuix-ui` primitives set roles and accessible names (buttons, nav items, text fields, selects, file
tree, sidebar and conversation lists); screen-reader behaviour has not yet been verified with a real
assistive technology. GPUIX still exposes no secure-text input, so the login keeps its visible
warning and credential rollout remains blocked until the renderer provides one.

On Linux, GNOME's compositor draws no server-side decorations for Wayland clients and GPUIX draws no
client-side titlebar, so the client relaunches itself under XWayland on GNOME Wayland sessions
(`FUNNY_GPUIX_LINUX_BACKEND=wayland` opts out).

The same release exposes element focus events but no verified independent window-focus callback.
Funny does not infer host inactivity from child blur: the native lifecycle remains conservatively
active while the window exists and becomes inactive only at the verified stop/termination boundary.

## Verification policy

The `gpuix-contract` matrix runs `gpuix-ui` typecheck/tests and product-client tests/build/package
smoke on Linux, macOS, and Windows. Native renderer tests report explicit skips when the capability
is absent. Because GPUIX 0.11.0 is expected to supply `TestGpuixRenderer` on macOS and Windows, those
jobs run a prerequisite check and fail rather than silently accepting only portable evidence.

Visual capture on Metal and DirectX waits for a stable automation marker across consecutive reads
before taking the screenshot. If readiness times out, the script records `captured: false` with the
reason and exits unsuccessfully. Linux continues recording screenshot capture as unsupported while
retaining structural evidence.

## Registry evidence

- `@gpuix/react@0.11.0` integrity:
  `sha512-jFbpCT2B1wSUajbItZGPr0bLhx5DDvljQL9l19tOg5ZoJlizZfv5lCnzQoi6ApQOM6//8zl5sQxVnG60CAYLuQ==`
- `@gpuix/native@0.11.0` integrity:
  `sha512-xnPBArvvkg6aD7/soznkzio3qrKP6yHzhTJ0uOZoRYnp4OgdO8kkSKidAryvCbyF39/C0/+3P+7FzgsGTOXsXg==`
- Repository: `https://github.com/remorses/gpuix`
