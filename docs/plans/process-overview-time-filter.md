# Process overview time filter

**GitHub Issue:** #10 (frontend remainder)
**State:** open
**Labels:** enhancement, frontend

## Description

Split out from `stub-process-timestamps.md`. The backend half (timestamps on process
versions) is done — see `docs/plans/done/stub-process-timestamps.md`. Process versions now
carry `created_at`, `started_at`, and `completed_at` (with a computed `run_length`), served
by the API but not yet consumed by the UI for filtering.

* [ ] Add a time filter to the process overview

## Scope

Add a UI control in the process overview (FlowView / process list) that lets the user
filter or sort process versions by their timestamps — e.g. a date-range picker or a
"last 24h / 7d / all" quick filter — using the `created_at` / `started_at` / `completed_at`
fields already returned per version.
