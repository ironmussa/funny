# Sätteri WASI browser binding

This directory is the unmodified package payload from
`@bruits/satteri-wasm32-wasi@0.9.5`, except that its `cpu: ["wasm32"]`
restriction has been removed from `package.json` and its generated browser
loader has a lint directive for its upstream underscored internals.

Bun does not accept `wasm32` as an install architecture and otherwise skips the
package, even when it is a direct dependency. The binding is a browser asset,
not host-native code, so the restriction is inapplicable when Vite bundles it.

- Source: https://github.com/bruits/satteri
- License: MIT (as declared by the package)
- npm integrity: `sha512-zauAuMwfPnKPUkd4AFixRFpXdgKwP2mKgxrIIo2gJzW0/ZneF9dbHnLkojSpaBnCCp7VUL1hIi5WWZvB1CqmAQ==`
- WASM artifact: `satteri_napi.wasm32-wasi.wasm`
