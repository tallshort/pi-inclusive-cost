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
bacnh85:<parent-session-path>:<tool-call-id>:<result-index>
bacnh85-background:<parent-session-path>:<task-id>
j0k3r:<parent-session-path>:<task-id>:<attempt>
j0k3r-session:<absolute-session-path>
fabric:<run-id>
taskflow:<run-id>:<trace-line>
taskflow-fallback:<execution-fingerprint>
```

A key is inserted once into the aggregate map. Collector-specific rules decide which persisted records represent paid calls.

## Collectors

| Collector | Authoritative source | Contribution identity |
| --- | --- | --- |
| Standard Pi sessions | Attributed Session JSONL assistant messages | `pi-session:<absolute-session-path>` |
| `@bacnh85/pi-subagent` | Foreground tool-result usage and background completion messages | Parent session path + tool call/result or background task identity |
| `pi-subagents-j0k3r` | Attributed task usage in parent `subagent_*` tool results | Parent session path + task attempt identity |
| Pi Fabric | Attributed run records returned by `fabric_exec` | `fabric:<run-id>` |
| Pi Taskflow | Usage-bearing events in an attributed run trace | `taskflow:<run-id>:<trace-line>` |

## Supported extensions

| Extension | Collector | Relationship and mechanism |
| --- | --- | --- |
| Standard full-session subagent modes | Standard Pi sessions | Layout-based compatibility for standard nested or parent-linked child sessions, independent of package naming |
| `@gotgenes/pi-subagents` | Standard Pi sessions | Independently maintained hard fork of `@tintinweb/pi-subagents`; uses its own `tasks/*.jsonl` layout |
| `@xzzpig/pi-subagents` | Standard Pi sessions | Fork of `nicobailon/pi-subagents`; persisted native runs retain the same nested-session mechanism |
| `oira666_pi-subagent` | Standard Pi sessions | Standard RPC sessions are nested below the parent session stem |
| `@bacnh85/pi-subagent` | `@bacnh85/pi-subagent` | Parent tool calls identify foreground results; completion messages identify background tasks |
| `pi-subagents-j0k3r` | `pi-subagents-j0k3r` | Parent tool results identify task attempts and their usage; explicit standard sessions are fallback only |
| Pi Fabric | Pi Fabric | Parent tool results identify runs; session exports are fallback only |
| Pi Taskflow | Pi Taskflow | Parent tool results identify project-local traces and snapshots |

`@tintinweb/pi-subagents` receives no package-specific collector: its configurable reporting can attach child usage to the parent Session. Named subagent rows apply only when the described attributable persistence mode is enabled; the generic first row describes a file-layout contract rather than blanket support for packages named `pi-subagents`.

## Module layout

- `inclusive-cost.ts` owns Pi event/command registration, invokes the collectors, combines their summaries, and renders the UI.
- `collectors/pi-sessions.ts` owns Standard Pi Session discovery, validation, cost summation, and extraction of attributed parent tool results and custom messages.
- `collectors/bacnh85.ts` owns bacnh85 foreground/background attribution and deduplication.
- `collectors/fabric.ts` owns Fabric result parsing, run deduplication, and export fallback.
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

Discovery runs to a fixed point. Absolute file paths are the deduplication identity.

Persisted native children from the `@xzzpig/pi-subagents` fork use `<session-stem>/run-*/session.jsonl` and are therefore covered by the generic nested-session collector without a package-specific collector. Runs configured without a persistent child session remain out of scope.

`oira666_pi-subagent` persists standard sessions under `<session-stem>/subagents/<parent-session-id>/<tool-call-id>/<index>/session.jsonl`. Directory containment makes them attributable, so the same generic nested-session collector covers them without relying on a child `parentSession` header.

### `@gotgenes/pi-subagents`

Current releases persist children in Pi's standard format under:

```text
<parent-session-stem>/tasks/*.jsonl
```

The child header records the parent session ID. Directory containment supplies the stable parent-file association; the header confirms that the file is a Pi session. Nested delegation creates another child session tree and is found by fixed-point discovery.

The installed fork accumulates token usage for its own UI but does not currently copy a priced usage object into the parent tool result. The `tasks/*.jsonl` child session is therefore the dedicated compatibility source implemented by this extension.

### `@bacnh85/pi-subagent`

Default SDK children use in-memory sessions. Foreground costs come from the parent `subagent` tool result's `details.results[].usage.cost`, keyed by parent Session path, `toolCallId`, and result index. Repeated observations retain the greatest cost; results already covered by parent tool-result usage and Herdr results are omitted.

Background launch receipts carry no cost. Completion records are persisted as `pi-subagent-complete` custom messages; their parent Session path, `task_id`, and `usage.cost` form one deduplicated contribution.

### `pi-subagents-j0k3r`

Persisted `subagent_run`, `subagent_continue`, status, result, list, and cancel tool results can expose tasks under `details.task`, `details.tasks[]`, or `details.results[]`. Inline `usage.cost` is authoritative. Repeated observations of the same parent Session, `task.id`, and attempt retain the greatest cost, while continuation attempts remain separate contributions. Tasks already covered by parent tool-result usage are omitted.

When no inline usage was persisted for a task, an explicitly returned `nested_session_path` may supply a standard Pi Session fallback. The path must identify a valid Session JSONL; conflicting paths are omitted, and the collector never scans the package's global history directory.

### Pi Fabric

A persisted `fabric_exec` tool result can contain one or more Fabric run records. Fabric may render those records in `content`, or retain them only in successful `details.audits[]` entries for `agents.run`. Each record exposes a stable `id` and cumulative `usage.cost`; only the direct attributable audit result is parsed. The collector uses:

```text
fabric:<run-id>
```

Repeated results for the same run are collapsed, retaining the greatest observed cumulative cost. Agent names and timestamps are not identities.

Fabric can additionally export Pi-compatible usage sessions under:

```text
<agent-dir>/sessions/.fabric/<encoded-cwd>/<timestamp>_<run-id>.jsonl
```

The export repeats the same usage and is therefore only a fallback when the attributable tool-result record identifies the run but omits usable cost. A standalone `.fabric` file is never included merely because its `cwd` matches: its content does not identify the parent chat. Alternate export roots may be undiscoverable and are an accepted limitation.

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
| `@ferris1225/pi-subagents` | Planned | Standard sessions live in a separate project directory; parent results expose stable run and session references |
| `pi-better-subagents` | Planned | Standard sessions live in a separate temporary tree without a parent header; spawn results expose a stable `runId` |
| `@esso0428/pi-subagents` | Blocked | Defaults to in-memory children and custom `.output` transcripts without attributable priced usage |
| `@narumitw/pi-subagents` | Blocked | Uses `--no-session` and does not return child usage/cost |
| `wj-pi-subagents` | Blocked | Uses `--no-session`; runtime child replies contain no usage/cost |

Planned collectors must start from references persisted in the current parent chat and must not scan shared global or project directories. The implementation work is recorded in [`TODO.md`](https://github.com/tallshort/pi-inclusive-cost/blob/main/TODO.md).

## Refresh and presentation

Collection runs on `session_start`, `turn_end`, `agent_end`, and `/cost`. The statusline shows the inclusive total only when at least one attributed delegated contribution exists. `/cost` preserves the original three-line presentation—direct cost, inclusive cost, and folded delegated count—while collector-specific accounting remains internal.

## Known limitations

- Unpersisted/headless children without a stable parent link are not counted.
- Artifacts-only subagent transcripts are not counted.
- Fabric calls whose persisted rendered output and structured audit details both hide every run ID cannot be associated with the chat.
- Fabric exports redirected outside the standard agent session tree are not discovered automatically.
- Old Taskflow snapshots without traces cannot preserve every historical recompute attempt.
- Parent tool-result usage without a stable child/run identity is ignored to avoid double-counting.
