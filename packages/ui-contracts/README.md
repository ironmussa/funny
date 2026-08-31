# @funny/ui-contracts

Dependency-free visual semantics shared by the React DOM and GPUIX clients.
It contains the parity-only `reference-dark` contract, the selectable `one-dark`
theme shared with React, layout metrics, semantic icon and
component-state vocabulary, and deterministic desktop/compact parity fixtures.

It intentionally contains no React, DOM, GPUIX, application stores, networking,
or persistence code. Renderers translate the same logical colors and dimensions
into their own native representation.

`VISUAL_THEME_NAMES`, `visualThemes`, `visualContract`, and
`isVisualThemeName` form the renderer-neutral registry. Theme selection and
persistence remain application concerns.
