# pi-inclusive-cost

[![npm version](https://img.shields.io/npm/v/pi-inclusive-cost?logo=npm)](https://www.npmjs.com/package/pi-inclusive-cost)
[![npm downloads](https://img.shields.io/npm/dm/pi-inclusive-cost?logo=npm)](https://www.npmjs.com/package/pi-inclusive-cost)
[![CI](https://github.com/tallshort/pi-inclusive-cost/actions/workflows/ci.yml/badge.svg)](https://github.com/tallshort/pi-inclusive-cost/actions/workflows/ci.yml)
[![GitHub stars](https://img.shields.io/github/stars/tallshort/pi-inclusive-cost?style=flat)](https://github.com/tallshort/pi-inclusive-cost/stargazers)

> [!NOTE]
> This repository is the `tallshort`-maintained fork of [serhii-chernenko/pi-inclusive-cost](https://github.com/serhii-chernenko/pi-inclusive-cost), which remains the upstream project.

A [Pi coding agent](https://pi.dev) extension that shows session cost **including subagent sessions**, not just the current thread.

<img width="1888" height="504" alt="shot-mrwgwdn7" src="https://github.com/user-attachments/assets/2e4f2de3-7447-4beb-993f-2222d8e08f3d" />

## The problem

Pi's built-in statusline sums cost from the current session's own message history only. If you use a subagent extension (e.g. one that spawns background workers, reviewers, researchers, etc.), those subagent sessions are written to their own nested session files and are invisible to the built-in cost total — so the number in your statusline can understate what a task actually cost by a wide margin.

## What this does

The extension rebuilds a deduplicated total from persisted records attributable to the current chat.

### Collectors

| Collector | Attributed source |
| --- | --- |
| Standard Pi sessions | Root and linked child Session JSONL files containing `usage.cost.total` |
| Pi Fabric | Run IDs and cumulative usage from `fabric_exec` rendered output or structured agent audit details, with attributable `.fabric` exports as fallback |
| Pi Taskflow | Run IDs returned by `taskflow`, then usage-bearing trace events or an older snapshot fallback |

### Supported extensions

| Extension | Collector | Notes |
| --- | --- | --- |
| Standard full-session subagent modes | Standard Pi sessions | Layout-based compatibility for nested `session.jsonl` or parent-linked sibling sessions; not a blanket claim about any package named `pi-subagents` |
| `@gotgenes/pi-subagents` | Standard Pi sessions | Independently maintained hard fork of `@tintinweb/pi-subagents`; supported through its `tasks/*.jsonl` layout |
| `@xzzpig/pi-subagents` | Standard Pi sessions | Fork of `nicobailon/pi-subagents`; persisted native children use the same nested-session mechanism |
| `oira666_pi-subagent` | Standard Pi sessions | Persisted RPC children use nested `subagents/.../session.jsonl` files under the parent session stem |
| Pi Fabric | Pi Fabric | Requires the parent chat to retain the Fabric run ID in rendered output or structured audit details |
| Pi Taskflow | Pi Taskflow | Requires the parent chat to retain the Taskflow run ID |

Support for a named subagent extension means its attributable persisted mode is covered; in-memory or explicitly non-persistent modes remain out of scope. The generic first row is based only on the standard persisted layout.

The statusline shows `$X.XX (incl) •` whenever attributable delegated work exists. `/cost` keeps the original compact summary: direct cost, inclusive cost with every supported subagent backend folded in, and the number of folded delegated sessions/runs. Refresh happens on session start, at the end of every turn, and when the agent run ends.

See [`docs/DESIGN.md`](docs/DESIGN.md) for persistence layouts, source precedence, resume/cache/recompute behavior, contribution keys, and deduplication invariants.

It intentionally does not attempt token-based cost *estimation* — it only sums `usage.cost.total` as already recorded in the session file. That field is itself a **client-side estimate** computed by the agent's model registry (input/output/cache token counts × that model's listed per-token price), not a number returned by your provider's billing API — so treat it as an estimate, not an authoritative bill. If your provider doesn't populate `usage.cost.total` at all, the inclusive total will read as `$0.00`.

## Install

```bash
pi install npm:pi-inclusive-cost
```

or directly from source:

```bash
pi install git:github.com/tallshort/pi-inclusive-cost
```

Restart Pi, or run `/reload`.

## Commands

- `/cost` — direct cost, inclusive cost, and the number of delegated sessions/runs folded into the total.

## Not currently collected

| Extension | Reason |
| --- | --- |
| `pi-subagents-j0k3r` | Stores standard sessions outside the parent tree without a `parentSession` header; a parent-tool-result collector is planned |
| `@ferris1225/pi-subagents` | Stores sessions in a separate project directory; a collector based on its returned `runId`/session reference is planned |
| `pi-better-subagents` | Stores standard sessions in a separate temporary tree without `parentSession`; a collector keyed by the returned `runId` is planned |
| `@bacnh85/pi-subagent` | Defaults to in-memory sessions; a collector for attributed foreground/background tool-result usage is planned |
| `@esso0428/pi-subagents` | Defaults to in-memory children and custom `.output` transcripts without attributable priced usage |
| `@narumitw/pi-subagents` | Starts children with `--no-session` and does not return usage/cost |
| `wj-pi-subagents` | Starts children with `--no-session`; child replies contain text but no usage/cost |

Planned collector work is recorded in [`TODO.md`](https://github.com/tallshort/pi-inclusive-cost/blob/main/TODO.md). `@tintinweb/pi-subagents` receives no package-specific collector here because its configurable reporting mechanism can attach child usage to the parent Session itself.

The unscoped `pi-subagents` name in the preserved upstream limitation below did not include a package identity or version range. Treat it as a description of the observed artifacts-only layout, not as a claim about every similarly named npm package or fork.

## Known limitation: newer artifacts-only subagent storage isn't covered yet

`pi-subagents` has changed how it persists at least one subagent mode (parallel/fork batches) between versions. Older versions always wrote a full session file for every subagent invocation, nested or as a flat sibling — the two mechanisms above. A newer mode instead writes only to `<project-cwd>/.pi-subagents/artifacts/<runId>_<agent>_<index>_meta.json` (plus a `_transcript.jsonl` with a different record schema), with **no corresponding session file anywhere** — nested or sibling. That cost is currently invisible to this extension.

This wasn't skipped by accident: there's no reliable way to attribute a given artifacts file back to one specific chat. The only correlation lead found (a `session_info` entry naming the subagent, written into the parent's own session file) turns out to depend on the `pi-intercom` package being installed — not a safe thing to build a core feature on. A worktree-wide sum without that correlation would also reintroduce exactly the cross-chat over-counting problem this extension was built to avoid in the first place (multiple unrelated chats in the same project folder getting lumped together). Until there's a first-party, version-stable way to scope this correctly, it's left uncovered rather than shipped fragile or wrong.

Collector-specific limitations for Fabric and Taskflow are documented in [`docs/DESIGN.md`](docs/DESIGN.md).

## Don't expect this to match your provider's billing dashboard exactly

`usage.cost.total` is computed locally from token counts and a local price table — it is not your provider's authoritative bill. Even with accurate, current pricing, a locally-summed total can diverge from what your provider's own usage dashboard reports, for reasons outside this extension's control: reporting lag on the provider's side, per-request billing multipliers instead of per-token metering, or negotiated/enterprise rates that differ from the public price list. If you need a number that reconciles with billing, treat this as a fast local signal, not a substitute for your provider's own dashboard.

For a full project-wide audit across every chat (not just the current one), use a dedicated usage-dashboard tool — this extension is meant for a quick, live, per-chat signal in the statusline.

## Releases

Bump `version` in `package.json`, commit, then push a matching tag:

```bash
git tag v0.1.3
git push origin main v0.1.3
```

The tag workflow type-checks, publishes to npm through npm Trusted Publishing, and creates a GitHub Release with generated notes. No npm token is stored anywhere — the trust relationship is configured once on npm's side for GitHub repository `tallshort/pi-inclusive-cost` and workflow filename `publish.yml` (`npm trust github pi-inclusive-cost --repo tallshort/pi-inclusive-cost --file publish.yml --allow-publish`, npm CLI ≥11.15.0).

## License

MIT
