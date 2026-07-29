# Funny Remote Connector

`@funny/remote-connector` is the private Rust source package for the separately
installed `funny-remote-connector` service. It is an executable product, not a
library for Funny runtime or agent code.

The internal dependency direction is:

```text
main -> service -> core
               \-> platform contracts and adapters
```

The Connector must not import runtime, agent, server, client, or core
implementation modules. Those packages communicate with an installed Connector
only through the versioned shared protocol over protected local IPC.
`@funny/shared/remote-connector-protocol` remains the wire-contract source of
truth; generated fixtures keep its Zod schemas and the private Rust wire types
in conformance.

## Development

```bash
bun run --cwd packages/remote-connector test
bun run --cwd packages/remote-connector typecheck
bun run --cwd packages/remote-connector build
```
