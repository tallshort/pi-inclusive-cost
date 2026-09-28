# TODO

## Additional subagent collectors

- [ ] Add a `pi-subagents-j0k3r` collector.
  - Discover only runs referenced by the current chat's persisted tool results.
  - Treat `details.tasks[].usage.cost` as the authoritative source.
  - Deduplicate repeated task/status results by stable task identity and retain the greatest cumulative cost.
  - Use the package's external standard Pi session JSONL only as a fallback when the parent result supplies a stable session reference; never scan the global history directory indiscriminately.
  - Add regression coverage for repeated results, unrelated global sessions, missing usage, and fallback behavior.

- [ ] Add an `@ferris1225/pi-subagents` collector.
  - Discover only runs referenced by the current chat's `details.results[]` records.
  - Use `runId` as the run identity and `details.results[].usage.cost` as the authoritative source.
  - Fall back to the explicitly referenced `sessionDir` and `sessionId` standard Pi JSONL when inline usage is unavailable.
  - Never aggregate the project-wide `ferris-pi-subagents` session or results directories.
  - Add regression coverage for repeated run results, resumed runs, unrelated project sessions, and session fallback.

## Upstream prerequisite

`@narumitw/pi-subagents@3.1.0` is not currently collectible: it starts children with `--no-session` and does not persist or return usage/cost. Supporting it requires the extension to expose stable `jobId + usage.cost` data or attributable standard child sessions first; no `pi-inclusive-cost` implementation is planned until that prerequisite exists.
