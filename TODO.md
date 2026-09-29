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

- [x] Add an `@ian-pascoe/pi-minimal-subagents` registry collector.
  - Read only root Session `type: "custom"`, `customType: "minimal-subagents.registry"` entries owned by that root Session ID.
  - Treat Registry V2 `turn-settled.result.usage.cost.total` as authoritative and key contributions by root, agent, and turn identity; intentionally ignore legacy V1 records.
  - Replay valid V2 checkpoints for state only; do not treat checkpoint `latest_result`, delivery-ledger results, or coordinator messages as additional paid calls; ignore foreign-root, malformed, and missing-usage records while retaining valid zero-cost turns.
  - Do not fall back to the child `session_file`: it may contain imported, multi-turn, or fork-cloned history without a safe per-turn boundary.
  - Add regression coverage for V2 checkpoint/ledger/hierarchy/delete replay, rejected V1 events and checkpoints, repeated turns, foreign roots, missing/zero usage, and child Session exclusion.

- [x] Add a `pi-subagents-lite` parent-record collector.
  - Read foreground cumulative cost from attributed `Agent` tool results that persist `details.cost`, keyed by parent Session and `toolCallId`/agent identity.
  - Read background cumulative cost only from persisted `customType: "subagent-result"` completion messages, keyed by parent Session and agent/completion identity.
  - Retain the greatest cumulative cost for repeated observations and ignore launch receipts, status reads, and in-memory-only `totalAgentCost` state.
  - Do not search for child Session JSONL because the default runner uses `SessionManager.inMemory()`.
  - Add regression coverage for foreground completion, background completion, repeated cumulative records, launch-only records, missing cost, and unrelated custom messages.

- [x] Add a `pi-better-subagents` retained-child-session collector.
  - Discover only successful run IDs persisted by attributed `subagent_spawn` and `subagent_spawn_batch` results.
  - Require matching run metadata for the exact parent Session ID and working directory, then locate a unique standard child Session under the run's sandboxed per-run directory.
  - Stream assistant `usage.cost.total`, key contributions by run ID, preserve valid zero-cost runs, and recursively follow attributed nested launch receipts.
  - Ignore foreign metadata, ambiguous or missing child Sessions, shared non-sandbox session trees, and log-only runs; never scan or parse large `output.log` files.
  - Add regression coverage for single/batch launch results, duplicates, nested launches, foreign runs, zero cost, and cleaned/missing Sessions.

- [x] Add explicit Herdr child Session collectors.
  - Collect `@henryqw/pi-subagent` direct-mode Sessions from attributed `delegate_task` launches and correlated `subagent-direct-result` tab references.
  - Collect `pi-herdr-agents` Sessions only from its exact persisted started-launch shape; never scan shared Herdr directories.
  - Require absolute non-symlink standard Session files, exclude fork-inherited parent entry IDs, and avoid recounting files already found by Standard Pi discovery.
  - Leave Henry isolated mode unsupported because it uses `--no-session` and does not persist usage/cost in the parent result.
  - Add regression coverage for repeated references, unrelated completion messages, fork-history exclusion, and cross-collector deduplication.

- [x] Add a Pi Dynamic Workflows cumulative run collector.
  - Discover only stable run IDs persisted by attributed `workflow` tool results in the current Session tree.
  - Derive the exact project namespace from the attributed cwd and read only the bounded v2 run head, with legacy exact-path fallback; never read the large events log or scan shared run directories.
  - Require matching indexed run ID, immutable parent Session ID, and canonical parent Session file before accepting cumulative `index.tokenUsage.cost`.
  - Key by run ID so retries/resume/cache-miss additions use the latest cumulative total once; use foreground inline usage only when the head is absent.
  - Preserve genuine zero cost, omit estimated-zero unknown cost, and document partial mixed-usage limitations.
  - Add regression coverage for modern and legacy heads, duplicate results, artifact precedence, foreign lineage, zero/unknown cost, and inline fallback.
