## 1. Durable mutation acknowledgements

- [x] 1.1 Return serializable success acknowledgements from every persistent mutation handler that currently returns no value
- [x] 1.2 Add regression coverage proving successful fire-and-forget mutations complete and replay their idempotency claims

## 2. Runner gRPC-only client

- [x] 2.1 Require the gRPC endpoint in runner team mode and remove protocol selection and Socket.IO fallback behavior
- [x] 2.2 Remove runner-v1 client handlers, direct HTTP registration metadata, dead configuration, and the runtime Socket.IO client dependency
- [x] 2.3 Update runner transport tests for missing endpoint, reconnect, and no-downgrade behavior

## 3. Server gRPC-only routing

- [x] 3.1 Remove the `/runner` Socket.IO namespace and runner-v1 control, data, event, and presence handlers while preserving browser Socket.IO
- [x] 3.2 Route browser PTY, session, data, events, WebSocket tunnel, and HTTP tunnel operations exclusively through active gRPC sessions
- [x] 3.3 Remove canary assignment, v1 rollback, direct runner HTTP fallback, and obsolete shared runner-v1 protocol surfaces
- [x] 3.4 Update server routing and lifecycle tests to prove gRPC-only behavior and browser compatibility

## 4. Configuration and documentation

- [x] 4.1 Update environment examples and package dependencies for the required runner gRPC endpoint and server listener
- [x] 4.2 Replace mixed-rollout guidance with a gRPC-only deployment, monitoring, and binary-rollback runbook
- [x] 4.3 Update OpenWiki architecture and workflow documentation to remove runner Socket.IO and direct HTTP fallback claims

## 5. Verification

- [x] 5.1 Run focused server/runtime tests and the gRPC compatibility, sustained-load, and ingress harnesses
- [x] 5.2 Run `bun run lint` and `bun run typecheck`
- [x] 5.3 Validate the OpenSpec change and confirm no runner-v1 fallback references remain outside historical archives
