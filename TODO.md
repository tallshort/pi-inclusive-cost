# TODO

## Additional subagent collectors

These collectors are needed because the audited package versions expose attributable child costs but do not report them through parent Pi tool-result usage.

- [x] Add shared attributed-collector infrastructure.
  - Retain the parent `toolCallId` on attributed tool-result records so collectors can build stable per-call identities.
  - Expose one reusable helper for summing an explicitly referenced Standard Pi session JSONL without broad directory scanning.
  - Share keyed-contribution insertion and greatest-cumulative-cost deduplication where collector semantics match.
  - Keep package-specific discovery and attribution rules inside each collector.
- [x] Add a `pi-subagents-j0k3r` collector.
  - Discover only runs referenced by the current chat's persisted tool results.
  - Treat `details.tasks[].usage.cost` as the authoritative source.
  - Deduplicate repeated task/status results by stable task identity and retain the greatest cumulative cost.
  - Use the package's external standard Pi session JSONL only as a fallback when the parent result supplies a stable session reference; never scan the global history directory indiscriminately.
  - Add regression coverage for repeated results, unrelated global sessions, missing usage, and fallback behavior.

- [x] Add an `@ferris1225/pi-subagents` collector.
  - Discover only Ferris runs whose stable `runId` appears in the current chat's attributed `subagent` launch results.
  - Use cumulative `details.runs[].usage.cost` from persisted `subagent_status` results as the authoritative source.
  - Fall back to the explicitly referenced `sessionDir` and `sessionId` standard Pi JSONL when inline usage is unavailable.
  - Never aggregate the project-wide `ferris-pi-subagents` session or results directories.
  - Add regression coverage for repeated status results, cross-session run IDs, unrelated package shapes, parent-reported usage, unrelated project sessions, and session fallback.

- [ ] Add a `pi-better-subagents` collector.
  - Discover only runs whose stable `runId` was returned by a `subagent_spawn` result persisted in the current parent chat.
  - Resolve the referenced registry/session location and sum the run's standard Pi assistant `usage.cost.total`; do not scan `/tmp/pi-better-subagents/sessions` indiscriminately.
  - Treat text-only `subagent_result(include: ["cost"])` output as non-authoritative unless a stable structured format is documented.
  - Deduplicate spawn, result, and repeated status/query records by `runId`.
  - Add regression coverage for unrelated temporary sessions, repeated queries, missing sessions, and completed runs.

- [x] Add an `@bacnh85/pi-subagent` tool-result collector.
  - Use the parent `toolCallId` retained by the shared attributed-tool-result infrastructure for foreground identity.
  - Read foreground costs from `details.results[].usage.cost`, keyed by parent `toolCallId` plus result index.
  - Read background completion costs from the completion result's `task_id` and `usage.cost`, keyed by `task_id`.
  - Ignore launch-only records and deduplicate completion follow-ups and repeated queries so one in-memory child contributes once.
  - Keep Herdr-created sessions out of the generic collector unless a stable parent association or explicit session reference is available.
  - Add regression coverage for foreground batches, background completion, repeated retrieval, and foreground/background non-overlap.

- [x] Add an `@pi-archimedes/subagent` tool-result collector.
  - Read authoritative costs from the current parent chat's persisted `details.results[].usage.cost` records; no child Session fallback exists because children run with `--no-session`.
  - Prefer a valid Pi UUIDv7 in `childSessionId` as the contribution identity and fall back to parent `toolCallId` plus result index when necessary.
  - Ignore transient `Events.COST_UPDATE` bus events because they are not a stable persisted billing source.
  - Deduplicate repeated persisted results so one synchronous child result contributes once.
  - Add regression coverage for multi-result calls, repeated results, missing/zero usage, and stable-ID fallback.

- [ ] Add an `@ian-pascoe/pi-minimal-subagents` registry collector.
  - Read only `type: "custom"`, `customType: "minimal-subagents.registry"` entries persisted in the current root Session.
  - Treat settled-turn registry usage as authoritative and key contributions by stable agent plus turn/session identity.
  - Use an explicitly referenced child `session_file` as fallback only when registry usage is unavailable; never scan all flat sibling sessions.
  - Deduplicate registry updates and delivery records so cumulative/replayed state does not charge the same child turn twice.
  - Add regression coverage for multiple agents and turns, replayed registry entries, unrelated flat sessions, missing usage, and referenced-session fallback.

- [x] Add a `pi-subagents-lite` parent-record collector.
  - Read foreground cumulative cost from attributed `Agent` tool results that persist `details.cost`, keyed by parent Session and `toolCallId`/agent identity.
  - Read background cumulative cost only from persisted `customType: "subagent-result"` completion messages, keyed by parent Session and agent/completion identity.
  - Retain the greatest cumulative cost for repeated observations and ignore launch receipts, status reads, and in-memory-only `totalAgentCost` state.
  - Do not search for child Session JSONL because the default runner uses `SessionManager.inMemory()`.
  - Add regression coverage for foreground completion, background completion, repeated cumulative records, launch-only records, missing cost, and unrelated custom messages.

## Suggested implementation order

1. `@ian-pascoe/pi-minimal-subagents`.
2. `pi-better-subagents`.

## Upstream prerequisite

`@narumitw/pi-subagents@3.1.0` is not currently collectible: it starts children with `--no-session` and does not persist or return usage/cost. Supporting it requires the extension to expose stable `jobId + usage.cost` data or attributable standard child sessions first; no `pi-inclusive-cost` implementation is planned until that prerequisite exists.
