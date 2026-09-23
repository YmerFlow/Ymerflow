# Process timestamps

**GitHub Issue:** #10
**State:** open
**Labels:** enhancement, frontend, backend

## Description

_Migrated from deprecated-nagelfluh #14 (originally by @redhog)_

* [x] Add timestamps to process versions for submission, execution start and completion / failure.

## Status

**Implemented.** `backend/models/process.py` adds `created_at`, `started_at`, and
`completed_at` to `ProcessVersion` and serializes them (plus a computed `run_length`).

The remaining frontend "time filter to process overview" item has been split out into
`docs/plans/process-overview-time-filter.md`.
