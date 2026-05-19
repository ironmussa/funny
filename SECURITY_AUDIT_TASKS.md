# Security Audit — Remediation Task List

Generated from the security audit report. Each task lists location, fix, and acceptance criteria (regression test where applicable).

---

## P0 — Block production until fixed

### [x] C1 — Add ownership check to queue cancel/update
- **File:** `packages/server/src/routes/threads.ts:882-901`
- **Fix:** Before `messageQueueRepo.cancel(messageId)` / `messageQueueRepo.update(...)`, fetch the thread and verify `thread.userId === userId`. Mirror the pattern used at :875 (GET) and :909 (DELETE thread).
- **Test:** Integration test where user A's session targets user B's `threadId` → expect 404, repo `cancel`/`update` not called.

### [x] C2 — Eliminate TOCTOU symlink race in scoped file I/O
- **File:** `packages/runtime/src/routes/files.ts:134-139, 182-186`
- **Fix:** Resolve once via `realpath()`, validate scope on the canonical path, then `readFile`/`writeFile` on that canonical path (not the original user-supplied path). Do not re-open by user path after the check.
- **Test:** Test that swaps a symlink between scope check and I/O → expect read/write to either fail or operate on the original canonical target, never escape scope.

### [x] H1 — Stop returning stack traces in error responses
- **File:** `packages/server/src/routes/runners.ts:58`
- **Fix:** Remove `stack` from the JSON body; log it server-side via the Abbacchio logger (`log` from `packages/runtime/src/lib/logger.ts`, with a `namespace`).
- **Test:** Force a 500 from that route, assert response body has no `stack` field.

### [x] H2 — Per-event authorization in `/runner` Socket.IO namespace
- **File:** `packages/server/src/services/socketio.ts:558-600` and sibling runner-namespace handlers
- **Fix:** Centralize `runnerUserId === msg.userId` check in a wrapper applied to every handler that carries a `userId`. Audit every `socket.on(...)` in the namespace.
- **Test:** Mock runner socket emits an event with mismatched `userId` → handler rejects + audit log entry.

---

## P1 — Next sprint

### [x] H3 — Shorten forwarded-identity replay window + add nonce cache
- **File:** `packages/shared/src/auth/forwarded-identity.ts:24`
- **Fix:** Reduce `SIGNATURE_MAX_SKEW_MS` to 30–60 s. Add an in-memory LRU keyed by `(userId, timestamp, signature)` that rejects duplicates within the window.
- **Test:** Replay the same signed triple within window → second call rejected.

### [x] H4 — Pin `socket.io` to an exact version
- **File:** `packages/server/package.json:41`
- **Fix:** Replace `"socket.io": "4"` with an exact version (e.g., `"4.7.5"` or latest verified). Run `bun install` to refresh the lockfile.
- **Test:** None (build + smoke).

### [x] H5 — TTL & rotation for runner invite tokens and bearer tokens
- **Files:** `packages/server/src/services/profile-service.ts:212-240`, `packages/server/src/lib/auth.ts:173`
- **Fix:** Add `expiresAt` to runner invite tokens (e.g., 30–90 days) and single-use semantics; document/shorten Better Auth bearer TTL or gate behind an explicit issue/revoke endpoint.
- **Test:** Expired invite token → registration rejected. Used token → second use rejected.

### [x] M2 — SSRF guard for MCP OAuth fetch targets
- **Files:** `packages/runtime/src/services/mcp-oauth.ts:99, 114, 128`, `packages/runtime/src/routes/mcp.ts:130`
- **Fix:** Resolve hostname, block loopback / link-local / RFC1918 / `169.254.169.254` ranges; require `https://` for non-loopback.
- **Test:** Configure `.mcp.json` with `http://169.254.169.254/...` → fetch rejected pre-flight.

### [x] M6 — Constrain `/api/browse/list` on Windows
- **File:** `packages/runtime/src/routes/browse.ts:55-95` (and `requirePickerPath()`)
- **Fix:** Mirror Unix homedir constraint on Windows, or maintain a blocklist of system roots (`C:\Windows`, `C:\Program Files`, `C:\ProgramData`).
- **Test:** Request to list `C:\Windows` → 403.

---

## P2 — Hardening

### [!] M3 — Remove `unsafe-inline` from CSP `style-src`
- **File:** `packages/server/src/index.ts:82`
- **Fix:** Move to nonces or static stylesheets. May require client work.

### [x] M4 — Consider `SameSite=Strict` for session cookie
- **File:** `packages/server/src/lib/auth.ts:164`
- **Decision needed:** Confirm no auth flow requires `Lax`. If safe, flip to `Strict`.

### [x] M5 — Enforce password policy on `ADMIN_PASSWORD` env
- **File:** `packages/server/src/lib/auth.ts:187-267`
- **Fix:** Validate against the same rules as `routes/invite-links.ts:194-206`. Reject and log if env-supplied value is too weak.

### [!] M7 — Auth secret rotation
- **File:** `packages/server/src/lib/auth.ts:37`
- **Decision needed:** Design rotate flow (env override, admin-only endpoint, session invalidation). Larger task — track separately.

### [x] L1 — Sanitize markdown rendering
- **Files:** `packages/client/src/components/thread/MessageContent.tsx:68`, `packages/client/src/components/MonacoEditorDialog.tsx:306`
- **Fix:** Add `rehype-sanitize` plugin to both `ReactMarkdown` invocations.

---

## P3 — Hygiene

### [x] L2 — Replace `"@funny/*": "*"` with `"workspace:*"`
- **Files:** various `package.json` (client + others)

### [~] L3 — Drop legacy unversioned encrypted blob format
- **File:** `packages/server/src/lib/crypto.ts:156-159`
- **Fix:** Add migration to re-encrypt legacy blobs as v1; remove the legacy parse branch.

### [x] L4 — Reject branch names starting with `-`
- **File:** `packages/core/src/git/worktree.ts:237` (`removeBranch`) and any other branch-name entry points
- **Fix:** Early validation: reject leading `-`.

---

## Status legend
- [ ] not started · [~] in progress · [x] done · [!] needs decision
