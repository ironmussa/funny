## ADDED Requirements

### Requirement: Per-file diff opens as a full-screen drill-down on mobile

The mobile review MUST present a selected file's diff as a full-screen overlay, NOT as the centered desktop `Dialog` (`DiffViewerModal`). This applies on a mobile viewport (`useIsMobile()`, under the 768px breakpoint) when the user selects a file in the review file list. The overlay MUST follow the existing mobile review-overlay pattern: a fixed full-screen container with a header bar (back control + file name) and the diff filling the body. The desktop centered diff Dialog MUST NOT appear on mobile. On non-mobile viewports the existing centered `DiffViewerModal` MUST continue to render unchanged.

#### Scenario: Tapping a file on mobile opens the full-screen diff

- **WHEN** the user is on a mobile viewport with the review file list open and taps a
  modified file
- **THEN** a full-screen diff overlay (`mobile-diff-overlay`) is shown
- **AND** the centered desktop diff Dialog (`expanded-diff-overlay`) is NOT rendered

#### Scenario: Desktop is unaffected

- **WHEN** the user is on a non-mobile viewport and opens a file's diff
- **THEN** the centered `DiffViewerModal` (`expanded-diff-overlay`) is shown
- **AND** the mobile diff overlay is NOT rendered

#### Scenario: Back returns to the file list

- **WHEN** the mobile diff overlay is open and the user activates the back control
- **THEN** the diff overlay closes and the review file list is shown again with its
  prior scroll position preserved

### Requirement: The mobile diff view is read-only

The mobile diff overlay MUST render the diff for review only. It MUST NOT expose line
selection, partial/patch staging, file staging, select-all/deselect-all, or commit
affordances. Staging and committing remain available only on desktop. The diff body
reuses the shared diff renderer (`ExpandedDiffView`) without its interactive
selection/staging props.

#### Scenario: No staging affordances on mobile

- **WHEN** the mobile diff overlay is open
- **THEN** no line-selection, stage, unstage, select-all, or commit control is present
  in the diff view

### Requirement: Prev/next navigation between files without leaving the diff

The mobile diff overlay header MUST provide previous/next controls that step through
the same ordered set of files shown in the review file list (`filteredDiffs`), and a
position indicator of the current file within that set. The previous control MUST be
disabled on the first file; the next control MUST be disabled on the last file.
Activating a control MUST load the neighboring file's diff in place without returning
to the list.

#### Scenario: Stepping to the next file

- **WHEN** the mobile diff overlay shows file _i_ of _N_ with _i < N_
- **THEN** the next control is enabled
- **AND** activating it loads file _i+1_'s diff in the same overlay and updates the
  position indicator to _i+1 of N_

#### Scenario: Disabled at the boundaries

- **WHEN** the mobile diff overlay shows the first file
- **THEN** the previous control is disabled
- **WHEN** it shows the last file
- **THEN** the next control is disabled

#### Scenario: Single file

- **WHEN** the review contains exactly one changed file and its diff is open
- **THEN** both the previous and next controls are disabled
