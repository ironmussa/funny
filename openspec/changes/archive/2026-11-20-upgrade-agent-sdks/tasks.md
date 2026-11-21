## 1. Dependency Alignment

- [x] 1.1 Update every Claude Agent SDK declaration to the reviewed `0.3.251` release and every Codex SDK declaration to `0.151.0`.
- [x] 1.2 Regenerate `bun.lock` and verify each agent SDK resolves to one intended version.

## 2. Codex Effort Compatibility

- [x] 2.1 Forward Funny's `max` effort as Codex's native `max` value while preserving existing effort mappings.
- [x] 2.2 Add regression tests covering `max` and the existing supported effort values at the Codex SDK boundary.

## 3. Verification

- [ ] 3.1 Run focused provider adapter tests and resolve any SDK compatibility regressions.
- [ ] 3.2 Run `bun run lint` and `bun run typecheck` successfully.
- [ ] 3.3 Validate the OpenSpec change and confirm all implementation tasks are complete.
