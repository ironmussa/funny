# Production-like ingress acceptance record

This record covers the local ingress portion of the Bun-to-Tonic compatibility
gate. It does not claim to be a live Railway deployment test; it reproduces the
documented edge properties that affect native gRPC before a canary is enabled.

## Railway constraints represented

Railway's edge terminates TLS and forwards requests to the deployment. Its
[public-networking limits](https://docs.railway.com/networking/public-networking/specs-and-limits)
require TLS 1.2 or newer, SNI, and support HTTP/2. Active HTTP requests may run
for up to 15 minutes when data continues to transfer and are otherwise closed
after five idle minutes. The
[edge-networking documentation](https://docs.railway.com/networking/edge-networking)
describes the client-to-edge TLS termination and subsequent forwarding path.

The harness models that path as:

```text
Tonic runner -- TLS 1.2+ / SNI / ALPN h2 --> Envoy edge
Envoy edge   -- HTTP/2 cleartext (h2c) ----> Bun grpc-js service
```

Envoy uses the pinned image digest printed by the gate. Both its route timeout
and HTTP/2 stream-idle timeout are disabled so long-lived streams are governed
by application deadlines and keepalive rather than a shorter proxy default.
The client and server use a 200 ms test keepalive interval, safely exercising
activity well inside Railway's documented five-minute idle window.

## Reproducible acceptance thresholds

Run from the repository root on Linux with Docker:

```sh
bun run protocol:compat:ingress
```

The command runs the full failure-injected sustained suite three times. It
passes only when every run preserves status/trailers, deadlines, cancellation,
keepalive, slow-reader backpressure, the 64 KiB binary frame limit, forced
disconnect/reconnect, and progress across all five communication classes.

| Measurement                     | Pass threshold |
| ------------------------------- | -------------: |
| Repetitions passing             |          3 / 3 |
| Maximum duration per repetition |      30,000 ms |
| Bun peak RSS                    |        256 MiB |
| Envoy peak memory               |        128 MiB |

These are spike gates, not production capacity guarantees. The memory ceilings
leave more than 2x headroom over the observed local values while still catching
unbounded buffering or a gross runtime regression. Production canary thresholds
will be defined separately with real Railway metrics and expected runner counts.

## Recorded result

Recorded on 2026-08-30. Values below are refreshed from the final gate run for
this task:

<!-- INGRESS_RESULT_START -->

| Item                 |     Observed |
| -------------------- | -----------: |
| Result               | 3 / 3 passed |
| Median duration      |     3,451 ms |
| Maximum duration     |     3,483 ms |
| Maximum Bun CPU time |       160 ms |
| Maximum Bun peak RSS |       98 MiB |
| Maximum Envoy CPU    |        2.69% |
| Maximum Envoy memory |    57.14 MiB |

Environment: Bun 1.4.0, Docker 29.5.0, Linux x64, 20 logical CPUs,
31,195 MiB host memory. Envoy image:
`envoyproxy/envoy@sha256:127e33c48c60be9a148cf9256d52e734ceda28aa344145023933116c7e524beb`.
<!-- INGRESS_RESULT_END -->
