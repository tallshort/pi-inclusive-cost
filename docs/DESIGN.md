# Design

## Purpose

`pi-inclusive-cost` reports the cost attributable to the current persisted Pi chat, including work delegated through supported orchestration extensions. It is deliberately session-scoped: sharing a working directory is not evidence that two runs belong to the same chat.

The collector reads existing `usage.cost.total` or an orchestration system's persisted `usage.cost`. It does not derive prices from token counts.

## Invariants

1. **Stable attribution is required.** A contribution is included only when a persisted record in the current chat identifies the child session or run.
2. **One paid model call contributes at most once.** Repeated status queries, repeated tool results, resume metadata, and cache hits do not create spend.
3. **Actual attempts remain distinct.** Retries, loop iterations, tournament candidates, and recomputations are counted when they produced separate usage-bearing calls.
4. **Authoritative sources and fallbacks are mutually exclusive.** A fallback is used only when the authoritative source for that run is unavailable.
5. **Totals are rebuilt from disk.** Every refresh reconstructs a contribution map instead of incrementing an in-memory counter.
6. **Unknown attribution is omitted.** It is preferable to under-count than to charge unrelated chats from the same workspace.

## Contribution model

Collectors produce keyed contributions:

```text
pi-session:<absolute-session-path>
archimedes:<child-session-id>
archimedes-fallback:<parent-session-path>:<tool-call-id>:<result-index>
lite-foreground:<parent-session-path>:<tool-call-id>
lite-background:<parent-session-path>:<agent-id>
minimal:<root-session-id>:<agent-id>:<turn-id>
better:<run-id>
herdr-session:<canonical-child-session-path>
bacnh85:<parent-session-path>:<tool-call-id>:<result-index>
bacnh85-background:<parent-session-path>:<task-id>
j0k3r:<parent-session-path>:<task-id>:<attempt>
j0k3r-session:<absolute-session-path>
ferris:<parent-session-path>:<run-id>
dynamic-workflow:<run-id>
fabric:<run-id>
taskflow:<run-id>:<trace-line>
taskflow-fallback:<execution-fingerprint>
```

A key is inserted once into the aggregate map. Collector-specific rules decide which persisted records represent paid calls.

## Collectors

| Collector | Authoritative source | Contribution identity |
| --- | --- | --- |
| Standard Pi sessions | Attributed Session JSONL assistant messages | `pi-session:<absolute-session-path>` |
| `@pi-archimedes/subagent` | Synchronous result usage in parent `subagent` tool results | Child Session ID, or parent Session/tool-call/result identity |
| `pi-subagents-lite` | Foreground `Agent` tool results and background completion custom messages | Parent Session/tool-call or attributed agent identity |
| `@ian-pascoe/pi-minimal-subagents` | Root Session registry v1/v2 `turn-settled.result.usage.cost.total` | Root Session ID + agent ID + turn ID |
| `pi-better-subagents` | Strictly attributed launch receipt plus retained sandboxed per-run standard child Session usage | Run ID |
| Explicit Herdr child Sessions | Attributed launch/result records with an absolute standard child Session path | Canonical child Session path |
| `@bacnh85/pi-subagent` | Foreground tool-result usage and background completion messages | Parent session path + tool call/result or background task identity |
| `pi-subagents-j0k3r` | Attributed task usage in parent `subagent_*` tool results | Parent session path + task attempt identity |
| `@ferris1225/pi-subagents` | Attributed launch identities plus cumulative usage in persisted `subagent_status` results | Parent session path + run ID |
| Pi Dynamic Workflows | Cumulative `index.tokenUsage.cost` in an exactly attributed persisted v2 run head | `dynamic-workflow:<run-id>` |
| Pi Fabric | Attributed run records in `fabric_exec` rendered output or successful `details.audits[].result` entries | `fabric:<run-id>` |
| Pi Taskflow | Usage-bearing events in an attributed run trace | `taskflow:<run-id>:<trace-line>` |

## Supported extensions

| Extension | Collector | Relationship and mechanism |
| --- | --- | --- |
| Standard full-session subagent modes | Standard Pi sessions | Layout-based compatibility for standard nested or parent-linked child sessions, independent of package naming |
| `@pi-archimedes/subagent` | `@pi-archimedes/subagent` | Synchronous parent tool results persist stable child Session IDs and usage |
| `pi-subagents-lite` | `pi-subagents-lite` | Foreground calls persist cumulative cost; background completions are linked to attributed launch IDs |
| `@ian-pascoe/pi-minimal-subagents` | `@ian-pascoe/pi-minimal-subagents` | Append-only root registry persists attributable terminal-turn usage |
| `pi-better-subagents` | `pi-better-subagents` | Launch receipts and callback origin identify sandboxed per-run child Sessions; nested launch receipts are followed recursively |
| `@henryqw/pi-subagent` | Explicit Herdr child Sessions | Direct-mode launch/results identify standard child Sessions; isolated mode is not persisted collectibly |
| `pi-herdr-agents` | Explicit Herdr child Sessions | Herdr launch results identify standard child Sessions; fork-inherited entries are excluded |
| `@gotgenes/pi-subagents` | Standard Pi sessions | Independently maintained hard fork of `@tintinweb/pi-subagents`; uses its own `tasks/*.jsonl` layout |
| `@nklisch/pi-subagents` | Standard Pi sessions | Maintained MIT fork of `@gotgenes/pi-subagents`; preserves `tasks/*.jsonl` while adding ordered lifecycle interception |
| `@xzzpig/pi-subagents` | Standard Pi sessions | Fork of `nicobailon/pi-subagents`; persisted native runs retain the same nested-session mechanism |
| `oira666_pi-subagent` | Standard Pi sessions | Standard RPC sessions are nested below the parent session stem |
| `@bacnh85/pi-subagent` | `@bacnh85/pi-subagent` | Parent tool calls identify foreground results; completion messages identify background tasks |
| `pi-subagents-j0k3r` | `pi-subagents-j0k3r` | Parent tool results identify task attempts and their usage; explicit standard sessions are fallback only |
| `@ferris1225/pi-subagents` | `@ferris1225/pi-subagents` | Launch results identify runs; persisted status results provide usage; explicit standard sessions are fallback only |
| Pi Dynamic Workflows | Pi Dynamic Workflows | Parent `workflow` results identify a run whose v2 head retains cumulative usage and immutable parent lineage |
| Pi Fabric | Pi Fabric | Parent tool results identify runs through rendered output or structured audit details; session exports are fallback only |
| Pi Taskflow | Pi Taskflow | Parent tool results identify project-local traces and snapshots |

`@tintinweb/pi-subagents` receives no package-specific collector: its configurable reporting can attach child usage to the parent Session. Named subagent rows apply only when the described attributable persistence mode is enabled; the generic first row describes a file-layout contract rather than blanket support for packages named `pi-subagents`.

## Module layout

- `inclusive-cost.ts` owns Pi event/command registration, invokes the collectors, combines their summaries, and renders the UI.
- `collectors/pi-sessions.ts` owns Standard Pi Session discovery, validation, cost summation, and extraction of attributed parent tool results and custom messages.
- `collectors/archimedes.ts` owns Archimedes result attribution and deduplication.
- `collectors/lite.ts` owns pi-subagents-lite foreground/background attribution and deduplication.
- `collectors/minimal.ts` owns minimal-subagents registry attribution and turn deduplication.
- `collectors/better.ts` owns pi-better-subagents launch attribution, child Session lookup, nested discovery, and streaming cost collection.
- `collectors/herdr-sessions.ts` owns explicit Herdr child Session attribution for Henry direct mode and pi-herdr-agents, inherited-entry exclusion, and cross-collector deduplication.
- `collectors/bacnh85.ts` owns bacnh85 foreground/background attribution and deduplication.
- `collectors/dynamic-workflows.ts` owns Dynamic Workflows run attribution, v2 head validation, cumulative cost, and foreground inline fallback.
- `collectors/fabric.ts` owns Fabric result parsing, run deduplication, and export fallback.
- `collectors/ferris.ts` owns Ferris launch/status attribution, deduplication, and explicit-session fallback.
- `collectors/j0k3r.ts` owns j0k3r task-result attribution, attempt deduplication, and explicit-session fallback.
- `collectors/taskflow.ts` owns Taskflow run lookup, trace accounting, and snapshot fallback.
- `collectors/shared.ts` contains internal record, contribution, and JSON-file helpers shared by collectors.

Each collector exposes one summary-producing interface; external persistence details remain inside its module.

## Collector details

### Standard Pi and legacy subagent sessions

A Pi session is a JSONL file whose first record has `type: "session"`. Assistant messages contribute their recorded `message.usage.cost.total`.

The current root session discovers descendants through:

- `<session-stem>/**/session.jsonl` for legacy nested workers;
- `<session-stem>/**/tasks/*.jsonl` for `@gotgenes/pi-subagents`;
- top-level sibling session files whose header `parentSession` points to the current parent file.

Discovery runs to a fixed point. Absolute file paths are the deduplication identity. When a parent-linked child contains fork-copied entries with IDs already present in its discovered parent, those inherited entries are excluded from both child cost and attributed-record extraction.

Persisted native children from the `@xzzpig/pi-subagents` fork use `<session-stem>/run-*/session.jsonl` and are therefore covered by the generic nested-session collector without a package-specific collector. Runs configured without a persistent child session remain out of scope.

`oira666_pi-subagent` persists standard sessions under `<session-stem>/subagents/<parent-session-id>/<tool-call-id>/<index>/session.jsonl`. Directory containment makes them attributable, so the same generic nested-session collector covers them without relying on a child `parentSession` header.

### `@gotgenes/pi-subagents`

Current releases persist children in Pi's standard format under:

```text
<parent-session-stem>/tasks/*.jsonl
```

The child header records the parent session ID. Directory containment supplies the stable parent-file association; the header confirms that the file is a Pi session. Nested delegation creates another child session tree and is found by fixed-point discovery.

The installed fork accumulates token usage for its own UI but does not currently copy a priced usage object into the parent tool result. The `tasks/*.jsonl` child session is therefore the dedicated compatibility source implemented by this extension.

`@nklisch/pi-subagents` retains this persisted child layout and standard assistant usage. Its ordered `beforeStart`/`beforeComplete` interception may abort or add bounded continuation turns, but every model turn that actually runs remains recorded in the same child JSONL. The Standard Pi collector therefore covers its costs without a package-specific collector.

### `@pi-archimedes/subagent`

Synchronous single and parallel calls persist `details.results[]` records with priced `usage.cost`. A valid Pi UUIDv7 in `childSessionId` is the preferred contribution identity. Missing or malformed IDs fall back to the parent Session path, `toolCallId`, and result index. Repeated records retain the greatest cost; zero-cost children remain valid contributions, while missing or parent-reported usage is omitted.

Children run with `--no-session`, so no Session-file fallback exists. Transient `Events.COST_UPDATE` notifications are not persisted billing records and are ignored.

### `pi-subagents-lite`

Foreground `Agent` tool results persist cumulative `details.cost`; contributions are keyed by parent Session path and `toolCallId`. Background launch receipts persist a 17-character agent ID but no cost. A `subagent-result` custom message contributes only when its controlled header's eight-character ID prefix uniquely matches an attributed launch in the same parent Session. Repeated observations retain the greatest cumulative cost.

Completion messages without a matching background launch are omitted, which also prevents foreground continuation notices from duplicating an earlier foreground contribution. Parent-reported usage takes precedence. Default children are in-memory, so the collector performs no child Session search.

### `@ian-pascoe/pi-minimal-subagents`

Version 0.9.0 persists append-only `minimal-subagents.registry` custom entries in the root Session. Registry versions 1 and 2 expose authoritative terminal model usage through `event: "turn-settled"` and `result.usage.cost.total`. Contributions use the owning root Session ID, `result.agent_id`, and `result.turn_id`; repeated observations retain the greatest cost, and a valid zero-cost turn remains countable.

Checkpoint `latest_result`, delivery-ledger results, coordinator custom messages, foreign-root records, and non-terminal events are not additional paid calls and are ignored. A persisted child `session_file` can contain imported history, multiple turns, or fork-cloned history without a durable per-turn usage boundary. The collector therefore does not sum child Session files when registry usage is missing, because doing so could duplicate or misattribute cost.

### `pi-better-subagents`

Persisted `subagent_spawn` and `subagent_spawn_batch` results identify successful run IDs. A run is accepted only when its metadata confirms the parent Session ID and working directory. Its retained sandboxed per-run standard Pi child Session is streamed once for assistant `usage.cost.total`; nested launch receipts are followed recursively and every run contributes at most once.

The collector does not scan the shared non-sandbox session tree or parse `output.log`: those sources may contain unrelated sessions or extremely large logs. If upstream cleanup has removed the attributed per-run child Session, that run is omitted rather than estimated.

### Explicit Herdr child Sessions

`@henryqw/pi-subagent` direct-mode `delegate_task` results persist a task ID and first child `sessionFile`; the correlated `subagent-direct-result` message identifies every launched tab's Session. `pi-herdr-agents` persists a package-specific started `subagent` result containing the child `sessionFile` and generated launch-script path. Only those attributed absolute paths are read; no Herdr directory is scanned.

A referenced path must be a non-symlink regular file with a valid standard Pi Session header. If its header declares `parentSession`, that path must resolve to the attributed parent Session, and entry IDs already present in the parent are excluded before assistant cost is summed. A valid priced message with `cost.total: 0` remains countable; a Session with no priced assistant message is omitted. A Session already found through the independent Standard Pi nested/parent-linked contract is left to that collector so it contributes once. Henry isolated mode remains unsupported because it runs with `--no-session` and its parent completion record omits usage/cost.

### `@bacnh85/pi-subagent`

Default SDK children use in-memory sessions. Foreground costs come from the parent `subagent` tool result's `details.results[].usage.cost`, keyed by parent Session path, `toolCallId`, and result index. Repeated observations retain the greatest cost; results already covered by parent tool-result usage and Herdr results are omitted.

Background launch receipts carry no cost. Completion records are persisted as `pi-subagent-complete` custom messages; their parent Session path, `task_id`, and `usage.cost` form one deduplicated contribution.

### `pi-subagents-j0k3r`

Persisted `subagent_run`, `subagent_continue`, status, result, list, and cancel tool results can expose tasks under `details.task`, `details.tasks[]`, or `details.results[]`. Inline `usage.cost` is authoritative. Repeated observations of the same parent Session, `task.id`, and attempt retain the greatest cost, while continuation attempts remain separate contributions. Tasks already covered by parent tool-result usage are omitted.

When no inline usage was persisted for a task, an explicitly returned `nested_session_path` may supply a standard Pi Session fallback. The path must identify a valid Session JSONL; conflicting paths are omitted, and the collector never scans the package's global history directory.

### `@ferris1225/pi-subagents`

A persisted `subagent` launch result supplies Ferris-specific run metadata and a stable numeric `runId`. Version 4.3.19 keeps that launch result pending even for `wait: true`; cumulative cost therefore comes from later persisted `subagent_status` records for a run already referenced by the same parent Session. Repeated status observations retain the greatest `usage.cost`. Runs covered by parent tool-result usage are omitted.

A compatible completed result may additionally supply explicit `sessionDir` and `sessionId` for one standard Pi Session fallback when inline usage is absent. Conflicting references, ambiguous filenames, and mismatched Session headers are omitted. The collector never scans the package's project-wide sessions or results directories. Detached completion messages contain formatted text rather than structured result details and are not treated as billing records.

### Pi Fabric

A persisted `fabric_exec` tool result can contain one or more Fabric run records. Fabric may render those records in `content`, or keep them only in successful `details.audits[]` entries for `agents.run`. Each record exposes a stable `id` and cumulative `usage.cost`. The collector accepts only attributable `agents.run` audit results and uses:

```text
fabric:<run-id>
```

Repeated results for the same run are collapsed, retaining the greatest observed cumulative cost. Agent names and timestamps are not identities.

Fabric can additionally export Pi-compatible usage sessions under:

```text
<agent-dir>/sessions/.fabric/<encoded-cwd>/<timestamp>_<run-id>.jsonl
```

The export repeats the same usage and is therefore only a fallback when the attributable tool-result record identifies the run but omits usable cost. A standalone `.fabric` file is never included merely because its `cwd` matches: its content does not identify the parent chat. Alternate export roots may be undiscoverable and are an accepted limitation.

### Pi Dynamic Workflows

An attributed `workflow` tool result supplies a stable `details.runId`. New run heads are located without directory scans at:

```text
~/.pi/workflows/projects/<project-slug>-<cwd-hash>/runs/<run-id>.json
```

The legacy exact path `<cwd>/.pi/workflows/runs/<run-id>.json` is also accepted. The collector reads only this small `pi-workflow-run-v2` head (bounded to 1 MiB), never the potentially large `.events.jsonl`. Its indexed `runId`, immutable `parentSessionId`, and canonical `parentSessionFile` must match the attributed parent record.

`index.tokenUsage.cost` is the runtime's cumulative run total and is keyed once as `dynamic-workflow:<run-id>`. It already incorporates committed parallel calls, retries, resume history, and newly executed cache misses; journal cache hits add no new usage. Repeated launch/result records therefore do not add snapshots together. A foreground `details.tokenUsage.cost` is used only when the head is absent; an invalid or foreign head fails closed. A genuine unestimated zero remains countable, while `estimated: true` with zero cost is treated as unknown and omitted. Mixed estimated/exact runs may expose only the known partial monetary cost.

### Pi Taskflow

A persisted `taskflow` tool result exposes `details.state.runId`; human-readable results also contain `Run id: ...`. Only run IDs found in tool results belonging to the root or an attributable descendant session are collected.

Taskflow stores project-local records at:

```text
<cwd>/.pi/taskflows/runs/index.json
<cwd>/.pi/taskflows/runs/<flow-name>/<run-id>.json
<cwd>/.pi/taskflows/runs/<flow-name>/<run-id>.trace.jsonl
```

The append-only trace is authoritative. Every `subagent-call` event contains the usage for one actual runner attempt. The collector sums `output.usage.cost` once per trace line:

- repeated status/trace queries return the same run ID and add nothing;
- retries and loop/tournament calls are counted from their usage-bearing events; a runner may emit separate attempt events or one event whose usage already aggregates its retries;
- cache hits have no paid `subagent-call` and add nothing;
- resume creates a child run whose trace contains only newly executed calls, so copied phase state is not charged again;
- recompute appends new `subagent-call` events to the same run trace, so its new attempts are counted.

For an older run with no usable trace, the run snapshot is a fallback. The collector sums non-cache phase usage, excludes phase executions that predate a resumed child run, and fingerprints execution timestamps to avoid charging copied phase state twice. This fallback cannot reconstruct overwritten historical recompute usage and may under-count old runs.

## Not currently collected

| Extension | Status | Reason |
| --- | --- | --- |
| `@esso0428/pi-subagents` | Blocked | Defaults to in-memory children and custom `.output` transcripts without attributable priced usage |
| `@narumitw/pi-subagents` | Blocked | Uses `--no-session` and does not return child usage/cost |
| `wj-pi-subagents` | Blocked | Uses `--no-session`; runtime child replies contain no usage/cost |

Any future collector must start from references persisted in the current parent chat and must not scan shared global or project directories. Unsupported extensions and their reasons are listed in the README.

## Refresh and presentation

Collection runs on `session_start`, `turn_end`, `agent_end`, and `/cost`. The statusline shows the inclusive total only when at least one attributed delegated contribution exists. `/cost` preserves the original three-line presentation—direct cost, inclusive cost, and folded delegated count—while collector-specific accounting remains internal.

## Known limitations

- Unpersisted/headless children without a stable parent link are not counted.
- Artifacts-only subagent transcripts are not counted.
- Fabric calls whose persisted rendered output and structured audit details both hide every run ID cannot be associated with the chat.
- Fabric exports redirected outside the standard agent session tree are not discovered automatically.
- Old Taskflow snapshots without traces cannot preserve every historical recompute attempt.
- Parent tool-result usage without a stable child/run identity is ignored to avoid double-counting.
- minimal-subagents turns without persisted registry usage are omitted; whole child Session totals are not a safe per-turn fallback.
- pi-better-subagents runs are omitted when their sandboxed per-run child Session is unavailable; shared session trees and large `output.log` files are intentionally not scanned.
- Dynamic Workflows runs with only estimated tokens and no reported monetary cost are omitted; mixed runs may expose a partial known cost.
- `@henryqw/pi-subagent` isolated-mode work is omitted because it has neither a child Session nor persisted parent usage; direct mode is covered.
- Ferris detached completion text is not parsed; a run needs a persisted structured status/completed result to be collectible.
