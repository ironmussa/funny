# Phase 0 spike — Cloudflare Workers + Durable Objects

Throwaway prototype for Phase 0 of [docs/plans/cloudflare-portability.md](../../docs/plans/cloudflare-portability.md).
It is not a workspace package and nothing here ships. Run date: 2026-11-09.

**Scope and the big caveat:** everything below ran in **local `workerd`** (wrangler's dev
runtime, `wrangler` 4.152.0) with Hyperdrive pointed at a local Postgres 16. Nothing was
deployed to a Cloudflare account. Local `workerd` is the same runtime Cloudflare runs, but
production limits, eviction/hibernation timing, CPU-time accounting, network latency and
billing are only observable on a real account — see [What still needs a real account](#what-still-needs-a-real-account).

## What the spike Worker models

`src/worker.js`, configured by `wrangler.jsonc`:

- **`RunnerSessionDO`** (one per runner): terminates the runner's outbound WebSocket with the
  hibernation API, keeps a monotonic epoch in DO storage, closes a replaced session, expires
  the session with an alarm when heartbeats stop, and forwards runner events to the owner's hub.
- **`UserHubDO`** (one per user): holds that user's browser sockets and fans events out.
- **Worker**: authenticates the runner (`Authorization: Bearer` at upgrade; the token carries
  the runner id and owner, signed with HMAC, as enrollment binds a real runner token to one
  runner and owner — identity headers from the caller are ignored) and the browser
  (Better Auth session cookie at upgrade) before handing the socket to a DO; serves Better
  Auth (username plugin, `pg` via Hyperdrive) and a Drizzle interactive-transaction probe.

`src/server-probe.ts` (`wrangler.server-probe.jsonc`) bundles and boots the **real**
`packages/server/src/app.ts` (`createServerApp`) in `workerd`.

## Results

From `results/local-workerd.json` (`run-spike.mjs`):

| #   | Question                                     | Result                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | Runner auth at upgrade                       | Wrong token → **401**, right token → **101**. Auth happens in the Worker before the DO sees the socket; the runner id and owner come only from the signed token.                                                                                                                                                                                                                                                                                    |
| E2  | Epoch fencing across replacement and restart | Epochs 1 → 2 (replacement; old socket closed with **4001**) → **3 after a full runtime restart**: the epoch lives in DO storage, so it is monotonic across restarts — stricter than today's in-memory counter that restarts at 0.                                                                                                                                                                                                                   |
| E3  | Frame sizes                                  | Runner → DO: up to **32 MiB accepted, 33 MiB rejected** (matches our 32 MiB gRPC limit). DO → runner: 33 MiB delivered locally (production cap unverified).                                                                                                                                                                                                                                                                                         |
| E3  | Send backpressure                            | **`bufferedAmount` does not exist** on the DO side of the socket. There is no send-backpressure signal; the in-band per-class buffer budgets (`max_buffered_bytes_per_class`) must carry it.                                                                                                                                                                                                                                                        |
| E4  | Heartbeat expiry via alarm                   | Alarm closed the session at **1996 ms** (timeout 2000 ms); presence `online: false`, `sockets: 0`; frames after that are not processed. The local Node client received the close frame (`CLOSING`) but never fired `close` — verify on a real account; the runner must treat a close frame as closed.                                                                                                                                               |
| E5  | Better Auth in a Worker                      | Sign-up 200, sign-in **200**, wrong password **401**, session cookie issued. Sign-in costs **~115 ms wall** locally, nearly all password hashing (scrypt, pure JS): over the Free plan's 10 ms CPU, fine on Paid (30 s default).                                                                                                                                                                                                                    |
| E6  | Browser socket + fan-out                     | No cookie → **401**, cookie → **101**. 200 runner events → browser: **p50 3 ms, p95 4 ms, max 6 ms** (local; adds real network hops in production). An event from another user's runner did **not** reach this browser, nor did one from a runner that sent a valid token for itself plus headers naming the victim's runner and owner; a token with a forged signature → **401**.                                                                  |
| E7  | Drizzle over Hyperdrive                      | Per-request `pg.Client`, interactive `db.transaction`: the row is visible inside (1), `tx.rollback()` rolls back, 0 rows after. **p50 11 ms** per request including connect (local Postgres).                                                                                                                                                                                                                                                       |
| E8  | Real `createServerApp` on Workers            | Bundles at **7.6 MiB / 1.3 MiB gzip** once `bun:sqlite` is aliased out (the only bundling error). **Fails at startup** if imported at global scope: the logger's telemetry identity calls `crypto.randomUUID()` on import, and Workers forbid random values, timers and I/O at global scope. Imported inside the handler, it boots and serves `/api/health` and `/api/bootstrap` → **200** (first request 2.2 s cold while all modules initialize). |

## Cost model (rough)

Prices from Cloudflare's published Durable Objects and Workers Paid pricing (third-party
mirrors and calculators; the official page could not be fetched from this session):
Workers Paid **$5/month** with 10 M requests and 30 M CPU-ms included; DO requests 1 M
included then **$0.15/M** (incoming WebSocket messages billed **20:1**, outgoing free);
DO duration 400 k GB-s included then **$12.50/M GB-s**, not billed while hibernated.

Workload assumption (a 50-person team): each user has a browser open 8 h/day and agents
streaming 3 h/day at ~20 events/s, 22 working days; 100 runners heartbeating every 15 s
around the clock.

| Item                                                                              | Volume / month          | Cost                       |
| --------------------------------------------------------------------------------- | ----------------------- | -------------------------- |
| Runner → DO event messages (billed 20:1)                                          | 238 M msgs → 11.9 M req | ~$1.6                      |
| RunnerDO → UserHubDO RPC, one per event                                           | 238 M req               | **~$35.5**                 |
| … same RPC batched every 500 ms (2 per second per streaming thread instead of 20) | ~24 M req               | ~$3.4                      |
| Heartbeats (billed 20:1)                                                          | 17 M msgs → 0.9 M req   | ~$0 (included)             |
| DO duration (~2 ms per handler, 128 MB)                                           | ~122 k GB-s             | $0 (included)              |
| Browser HTTP API                                                                  | ~2.2 M req              | $0 (included)              |
| Workers Paid base                                                                 | —                       | $5                         |
| **Total (batched fan-out)**                                                       |                         | **≈ $10/month** + Postgres |
| **Total (unbatched fan-out)**                                                     |                         | **≈ $42/month** + Postgres |

For comparison, one small always-on Railway service for the server is in the same
$5–20/month range. **Hosting the server on Cloudflare does not materially lower its cost**;
the cost lever is event batching (a 500 ms window adds up to half a second of
latency to streamed output, so the window is a product trade-off). Postgres (Neon, Railway, …) is the same on both hosts.

## Go / no-go

**Technical: go — no blocker found.** Everything the Cloudflare host needs worked in
`workerd`: authenticated runner and browser sockets in DOs, durable epoch fencing,
alarm-driven expiry, 32 MiB frames, cross-DO fan-out with per-user isolation, Better Auth,
and Drizzle transactions over Hyperdrive. The real server composition already runs once it
is loaded lazily.

**Economic: no case on server hosting cost alone.** The value of a Cloudflare host is
distribution ("deploy funny to your own Cloudflare account") and running the realtime tier
without operating a long-lived process, not a cheaper bill.

**Recommendation:** keep Phases 2–4 (they pay off on Bun regardless). Before committing to
Phase 5, spend one day on a real account to close the open questions below, and confirm
there is demand for a Cloudflare deployment option.

## Work this adds to Phase 5

- No random values, timers or I/O at module scope anywhere in the server's import graph
  (first offender: `getTelemetryIdentity` in `@funny/shared/lib/telemetry-identity`). Add a
  fitness check, or import the app lazily in the Worker entry (works, costs a cold start).
- Alias `bun:sqlite` out of the Worker bundle.
- Batch runner events before the RunnerDO → UserHubDO hop (cost, and fewer DO wake-ups).
- Do not rely on socket `bufferedAmount`; enforce the in-band buffer budgets.
- Plan for Paid-plan CPU limits on sign-in (scrypt), or move hashing to a cheaper KDF setting.

## What still needs a real account

- A runner socket held open for hours under hibernation: does it stay connected, and what is
  billed while it is idle?
- Close-handshake behavior seen by a real runner client when the DO closes the socket.
- DO → client frame size cap in production.
- CPU time of sign-in under real accounting; cold-start time of the full server bundle.
- Real latency: runner region → DO → browser region, and DO → Hyperdrive → Postgres.

## Running it

```bash
cd spikes/cloudflare-phase0
npm install
# A local Postgres. run-spike.mjs passes it to Hyperdrive through
# CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE; override with PG_URL.
# Hyperdrive requires a password in the URL (a trust-auth Postgres ignores it).
# Default: user and password "spike", 127.0.0.1:55432, database "funny".
# wrangler's dev runtime routes local requests through HTTPS_PROXY when it is set; unset it
# for these local-only runs.
env -u HTTPS_PROXY -u https_proxy node run-spike.mjs          # experiments E1–E7 → JSON
env -u HTTPS_PROXY -u https_proxy node probe-run.mjs          # E8: boot the real app
npx wrangler deploy --dry-run --outdir dist-probe -c wrangler.server-probe.jsonc   # E8 bundle
```
