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

- [ ] Add a `pi-better-subagents` collector.
  - Discover only runs whose stable `runId` was returned by a `subagent_spawn` result persisted in the current parent chat.
  - Resolve the referenced registry/session location and sum the run's standard Pi assistant `usage.cost.total`; do not scan `/tmp/pi-better-subagents/sessions` indiscriminately.
  - Treat text-only `subagent_result(include: ["cost"])` output as non-authoritative unless a stable structured format is documented.
  - Deduplicate spawn, result, and repeated status/query records by `runId`.
  - Add regression coverage for unrelated temporary sessions, repeated queries, missing sessions, and completed runs.

- [ ] Add an `@bacnh85/pi-subagent` tool-result collector.
  - Extend attributed tool-result records to retain the parent `toolCallId` needed for foreground identity.
  - Read foreground costs from `details.results[].usage.cost`, keyed by parent `toolCallId` plus result index.
  - Read background completion costs from the completion result's `task_id` and `usage.cost`, keyed by `task_id`.
  - Ignore launch-only records and deduplicate completion follow-ups and repeated queries so one in-memory child contributes once.
  - Keep Herdr-created sessions out of the generic collector unless a stable parent association or explicit session reference is available.
  - Add regression coverage for foreground batches, background completion, repeated retrieval, and foreground/background non-overlap.

## Upstream prerequisite

`@narumitw/pi-subagents@3.1.0` is not currently collectible: it starts children with `--no-session` and does not persist or return usage/cost. Supporting it requires the extension to expose stable `jobId + usage.cost` data or attributable standard child sessions first; no `pi-inclusive-cost` implementation is planned until that prerequisite exists.
