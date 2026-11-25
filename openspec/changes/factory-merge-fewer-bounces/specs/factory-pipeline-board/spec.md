# Spec Delta

## ADDED Requirements

### Requirement: The run panel shows what changed since an approval

For a run held for a high-risk approval whose hold records a difference from a commit a member
approved, the run detail panel SHALL show, above the risk class and its reasons: the approved
commit, the number of lines that differ, the files (those the approved
change did not touch marked as new), the risk reasons that are new, and why the approval did
not follow. Commits and file paths SHALL be shown as literal identifiers. The board card of
such a run SHALL say that the run asks again after a change of that many lines. A run held
without such a record SHALL show neither.

#### Scenario: Asking again after a small fix

- **WHEN** a member opens the panel of a run held on commit `bbb2222`, whose hold records an
  approval of `aaa1111` and a difference of 8 lines in one file the approved change did not
  touch
- **THEN** the panel shows `aaa1111`, "8 lines", the file marked as new and the reason, above the risk reasons, and the card says the run asks again after 8 lines changed

#### Scenario: A first hold

- **WHEN** a member opens the panel of a run held for an approval nobody gave before
- **THEN** the panel shows the risk class and its reasons and no difference
