# Spec Delta

## Purpose

Defines how the client holds server-backed entities (threads, projects, automations, templates, pipelines, runners) so that every view shows one consistent record, user actions apply instantly without visibly reverting, failures roll back with feedback, and realtime server events converge all open views.

## ADDED Requirements

### Requirement: Single canonical record per entity

The client SHALL hold exactly one canonical record per server-backed entity, identified by its server ID, and every view that shows that entity (sidebar, thread detail, Kanban, Activity, All Threads, search results, project views) SHALL read from that record.

#### Scenario: Rename is reflected everywhere

- **WHEN** a thread is renamed while it is visible in the sidebar, the Kanban board and the thread header at the same time
- **THEN** all three views SHALL show the new title without a reload and without any view showing the old title after the others updated

#### Scenario: Loading the same entity from two endpoints

- **WHEN** a thread arrives both in a project list response and in a thread detail response
- **THEN** the client SHALL keep one record for that thread, merging the fields, rather than two copies that can diverge

### Requirement: Optimistic writes apply immediately

User-initiated changes to a server-backed entity (including archive, unarchive, stage move, rename, pin, delete, project rename/reorder, automation enable/disable) SHALL be reflected in every affected view immediately, before the server responds.

#### Scenario: Moving a Kanban card

- **WHEN** the user drags a thread card from one Kanban column to another
- **THEN** the card SHALL appear in the destination column in the same frame the drop completes, and in no other column

### Requirement: Optimistic writes never revert on stale data

An optimistic change SHALL remain visible until the server confirms or rejects it. A list or detail response, or a realtime event, that reflects server state from before the write SHALL NOT make the change visibly revert, regardless of how long the server takes to respond.

#### Scenario: Stale list response during an archive

- **WHEN** the user archives a thread while a project thread-list request that started before the archive is still in flight, and that request resolves after the archive was applied optimistically
- **THEN** the thread SHALL stay archived in every view and SHALL NOT reappear in the active list, even briefly

#### Scenario: Slow confirmation

- **WHEN** the server takes longer than any fixed timeout (for example 10 seconds) to confirm a stage move while other list refreshes complete in between
- **THEN** the card SHALL stay in its new column for the whole period

#### Scenario: Confirmed state converges

- **WHEN** the server confirms the write and later responses or events reflect the confirmed state
- **THEN** the view SHALL show the confirmed server values, with no flicker when they equal the optimistic values

### Requirement: Failed writes roll back with feedback

When the server rejects an optimistic change, or the request fails, the client SHALL restore the entity to its latest server-confirmed state in every view and SHALL tell the user that the action failed.

#### Scenario: Archive rejected

- **WHEN** the user archives a thread and the archive request fails
- **THEN** the thread SHALL return to its previous list position and stage, and an error notification SHALL be shown

#### Scenario: Concurrent server change during a failed write

- **WHEN** a realtime event changes a thread's status while an optimistic rename of that thread is pending, and the rename then fails
- **THEN** the thread SHALL show the original title together with the new status from the realtime event

### Requirement: Realtime convergence

Realtime server events that create, update or delete a server-backed entity SHALL update the canonical record, and every open view SHALL reflect the change without a refetch. Events for entities the client does not hold SHALL NOT create partial records that views render as complete.

#### Scenario: Agent status change

- **WHEN** the server emits a status change for a thread shown in the sidebar and on the Kanban board
- **THEN** both views SHALL show the new status

#### Scenario: Thread deleted elsewhere

- **WHEN** a thread is deleted from another tab or by another client and the deletion event arrives
- **THEN** the thread SHALL disappear from every list and, if it was open, the detail view SHALL navigate away or show that the thread no longer exists

#### Scenario: Event for an unloaded project

- **WHEN** an update event arrives for a thread whose project list has never been loaded
- **THEN** that project's list SHALL NOT render as if it contained only that thread

### Requirement: Request de-duplication and freshness

Concurrent requests for the same server-backed list SHALL be de-duplicated, and a list that was loaded recently SHALL be served from the client without a new request unless the caller forces a refresh or the data is known to be stale.

#### Scenario: Two components mount together

- **WHEN** two components that need the same runner list mount at the same time
- **THEN** the client SHALL issue a single request for that list

#### Scenario: Forced refresh

- **WHEN** the user explicitly refreshes a list
- **THEN** the client SHALL fetch it again even if it is fresh, and SHALL keep pending optimistic changes applied on top of the result

### Requirement: Derived views stay consistent

Grouped, filtered and sorted views over the same entities (sidebar buckets per project, scratch list, shared-with-me list, Kanban columns, Activity, All Threads) SHALL be derived from the canonical records so that an entity appears in exactly the groups its current fields place it in.

#### Scenario: Archived thread leaves active views

- **WHEN** a thread becomes archived through any path (user action, realtime event, list refresh)
- **THEN** it SHALL be removed from every view that excludes archived threads and added to every view that shows archived threads, in the same update

#### Scenario: Scratch and project buckets are disjoint

- **WHEN** the client holds scratch threads and project threads
- **THEN** a scratch thread SHALL appear only in the scratch list and never in any project bucket, and a project thread SHALL never appear in the scratch list

### Requirement: Per-user data isolation on session change

Server-backed entity state SHALL be scoped to the authenticated user. On logout or user switch the client SHALL discard all held entities and pending optimistic changes before any data for the new session is shown.

#### Scenario: Logout then login as another user

- **WHEN** user A logs out and user B logs in in the same tab
- **THEN** no thread, project or automation of user A SHALL be visible to user B at any point, including from a cached list
