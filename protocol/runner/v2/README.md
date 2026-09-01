# Runner protocol v2

`runner.v2` is the normative wire contract between the central server and a
runner. The `.proto` sources in this directory are authoritative; generated
TypeScript and Rust files must not be edited by hand.

## Compatibility policy

Changes within `runner.v2` must remain wire compatible and pass Buf's `FILE`
breaking rules. In particular:

- Add fields with new tag numbers. Never reuse or renumber an existing tag,
  change its wire type, move it into or out of a `oneof`, or change a field
  between singular and repeated.
- Treat existing field and message semantics as stable. A compatible wire
  shape is not sufficient if an old peer would interpret the value
  differently.
- New fields must have behavior that is safe when an older peer omits or
  ignores them. Use `optional` when presence is distinct from a scalar's
  default value.
- Enum zero values remain `*_UNSPECIFIED`. Values may be appended, but callers
  must handle values unknown to their generated bindings and must not rely on
  exhaustive numeric ranges.
- New `oneof` alternatives may be added only when receivers can safely reject
  or ignore an alternative they do not understand. Do not change the meaning
  of an existing alternative.
- Do not expose authenticated runner, user, or tenant identity as authoritative
  payload fields. Identity is derived from transport credentials.

When removing a field, enum value, message, or RPC from a supported package,
first complete its deprecation and migration window. Reserve both the numeric
tag and the original name in the containing declaration, for example:

```proto
message Example {
  reserved 3, 5 to 7;
  reserved "old_field";
}
```

Reserved numbers and names are permanent within that package version. They
must never be recycled for a different meaning.

## Package versioning

Compatible additions stay in the `runner.v2` package and directory. A change
that requires renumbering, changes established semantics, removes behavior
before its compatibility window ends, or cannot be handled safely by an old
peer requires a new package such as `runner.v3` under `protocol/runner/v3`.

Package versions coexist during rollout. Negotiation selects a mutually
supported version before work is dispatched; adding a package does not imply
that existing versions can be removed.

## Generated artifacts

Generation is reproducible through the pinned Buf CLI and remote plugin
versions in `buf.gen.yaml`:

```sh
bun run protocol:generate
```

Generated artifacts are committed at these locations:

- TypeScript: `packages/shared/src/generated/runner-v2`
- Rust Prost/Tonic: `packages/runner-protocol-rust/src/generated`

After changing a schema, regenerate both targets and commit the source and
generated changes together. `bun run protocol:generate:check` regenerates and
fails when committed output differs. Never patch generated output directly;
change the `.proto` source or pinned generator configuration instead.

## Required checks

Run these checks for every protocol change:

```sh
bun run protocol:lint
bun run protocol:breaking
bun run protocol:generate:check
bun run protocol:fixtures:test
```

The breaking check compares with the first base branch containing
`protocol/runner/v2`. Set `RUNNER_PROTOCOL_AGAINST` to an explicit Git ref when
reviewing against a different baseline.

Golden fixtures live in `fixtures/golden.json` and are shared by the generated
TypeScript and Rust bindings. Add or update fixtures whenever a changed message
affects negotiation, failures, binary framing, idempotency, receipts/gaps, or
terminal sequencing. Regenerate wire bytes deliberately with:

```sh
bun run protocol:fixtures:update
```

Review every resulting `wireHex` diff. A fixture update must describe an
intentional compatible contract change; it must not be used to conceal an
unexpected encoder or schema change.
