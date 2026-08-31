# GPUIX product-client readiness

Audited on 2026-08-29 against the npm registry, installed declarations, and published package
metadata. The production client pins `@gpuix/react` and `@gpuix/native` to `0.5.1`. This release
contains the upstream unchanged-list fast path for native virtual lists while avoiding the broader
`0.6.0` upgrade in the same performance fix.

## Candidate native matrix

The native package publishes optional binaries for macOS arm64/x64, glibc Linux arm64/x64, and
Windows arm64/x64. A target remains a release candidate until Funny's native product smoke passes on
that target. Linux musl is unsupported because no musl binary is published.

Release-smoke status:

- glibc Linux x64: passed locally on 2026-08-24 using the extracted release tarball and only its
  declared dependencies.
- glibc Linux arm64, macOS arm64/x64, and Windows arm64/x64: binary published, but Funny release
  smoke not executed in this handoff.
- Linux musl: unsupported because GPUIX 0.5.1 publishes no compatible binary.

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

GPUIX 0.5.1 also exposes neither secure-text input nor accessibility/screen-reader labels in its
public intrinsic props. The product client provides visible warnings, keyboard focus, visible labels,
and deterministic automation IDs, but broader credential and accessibility rollout remains blocked
until those renderer capabilities exist.

The same release exposes element focus events but no verified independent window-focus callback.
Funny does not infer host inactivity from child blur: the native lifecycle remains conservatively
active while the window exists and becomes inactive only at the verified stop/termination boundary.

## Verification policy

The `gpuix-contract` matrix runs `gpuix-ui` typecheck/tests and product-client tests/build/package
smoke on Linux, macOS, and Windows. Native renderer tests report explicit skips when the capability
is absent. Because GPUIX 0.5.1 is expected to supply `TestGpuixRenderer` on macOS and Windows, those
jobs run a prerequisite check and fail rather than silently accepting only portable evidence.

Visual capture on Metal and DirectX waits for a stable automation marker across consecutive reads
before taking the screenshot. If readiness times out, the script records `captured: false` with the
reason and exits unsuccessfully. Linux continues recording screenshot capture as unsupported while
retaining structural evidence.

## Registry evidence

- Upstream commit: `301b834df4d0f28e8cfa2fde5e5693adeb909a7a`
- `@gpuix/react@0.5.1` integrity:
  `sha512-HbN+kJxgcELdXI5fEXYdfuT7ucQC4s+Q8xUfbtyfxQjoD6qVsKOZ4ZP0sqnGQYEp2Pf+EO9VGUARSSWwMljKMQ==`
- `@gpuix/native@0.5.1` integrity:
  `sha512-+sy72xd9LDJs7Jfrx4oGFwlOjMzX753gFAlUURxZ7jzctbZuS7XlORoo0IxF5OhKr8+1Xj1SGL3jf35Bz68u7g==`
- Repository: `https://github.com/remorses/gpuix`
