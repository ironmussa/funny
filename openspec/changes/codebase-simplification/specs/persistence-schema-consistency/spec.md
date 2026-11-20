# Spec Delta

## Purpose

Keeps the SQLite and PostgreSQL persistence backends behaviorally identical, so data written and read through either dialect has the same shape and JavaScript types.

## ADDED Requirements

### Requirement: Identical logical schema across dialects

Both database dialects MUST expose the same tables and the same columns per table. A column added to one dialect MUST be added to the other in the same change.

#### Scenario: Project closed flag on Postgres

- **WHEN** the server runs on PostgreSQL and a project is closed and reloaded
- **THEN** the project's closed state round-trips exactly as on SQLite

### Requirement: Drift is detected automatically

The test suite MUST fail when a dialect's schema definition, or a freshly migrated database of either dialect, differs from the canonical table/column set.

#### Scenario: Column missing in one dialect

- **WHEN** a developer adds a column to one dialect only
- **THEN** the schema-drift test fails naming the table and column

### Requirement: Epoch-millisecond values are numbers

Timestamp columns stored as epoch milliseconds MUST be returned to application code as JavaScript numbers on both dialects.

#### Scenario: Watcher wake time on Postgres

- **WHEN** a watcher with a `nextWakeAt` value is read on PostgreSQL
- **THEN** `typeof nextWakeAt === 'number'` and its value equals what was written
