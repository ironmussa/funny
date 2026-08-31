# GPUIX React diagnostics

`react-doctor` is DOM-oriented, while these packages compile through
`jsxImportSource: "@gpuix/react"`. Full scans on 2026-08-24 reported 18 product warnings and two
benchmark warnings. Two pending-state findings and one double traversal were genuine and fixed.

The remaining groups are classified as follows:

| Finding                                                                                                         | Classification                                                   | Confidence | Source evidence                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unknown DOM properties (`testId`, `source`, `code`, `patch`, `wordDiff`, `maxLines`, `alignment`, `followTail`) | False positive                                                   | High       | `@gpuix/react@0.5.1/dist/types/host.d.ts` declares these on `Props`, `MarkdownProps`, `CodeProps`, `DiffProps`, and `VirtualListProps`                                                       |
| Static-element interaction on `div` controls                                                                    | False positive for element choice; accessibility API gap remains | High       | GPUIX intrinsic elements have no `button`; `Props` declares click/key/focus handlers and `tabIndex`. Controls implement keyboard activation and visible text                                 |
| `autoFocus` on native input                                                                                     | False positive                                                   | High       | GPUIX `Props` documents that native input requires `autoFocus` or a click to receive key events. The application root is no longer focusable because child focus is not window lifecycle     |
| Placeholder-only fields                                                                                         | Confirmed renderer capability gap                                | High       | GPUIX `InputProps` has no label, accessibility-label, role, or screen-reader property. Visible adjacent text and deterministic `testId` are present, but semantic labeling cannot be claimed |
| Sequential await during session confirmation                                                                    | Intentional                                                      | High       | Each `get-session` attempt depends on the previous attempt observing the newly stored cookie; parallel requests would defeat the bounded retry                                               |

The product score is therefore not used as a rollout gate by itself. Accessibility remains an
explicit blocker in the rollout recommendation rather than being hidden through rule suppression.
