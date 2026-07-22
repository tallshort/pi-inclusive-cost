# pi-inclusive-cost

[![npm version](https://img.shields.io/npm/v/pi-inclusive-cost?logo=npm)](https://www.npmjs.com/package/pi-inclusive-cost)
[![npm downloads](https://img.shields.io/npm/dm/pi-inclusive-cost?logo=npm)](https://www.npmjs.com/package/pi-inclusive-cost)
[![CI](https://github.com/serhii-chernenko/pi-inclusive-cost/actions/workflows/ci.yml/badge.svg)](https://github.com/serhii-chernenko/pi-inclusive-cost/actions/workflows/ci.yml)
[![GitHub stars](https://img.shields.io/github/stars/serhii-chernenko/pi-inclusive-cost?style=flat)](https://github.com/serhii-chernenko/pi-inclusive-cost/stargazers)

A [Pi coding agent](https://pi.dev) extension that shows session cost **including subagent sessions**, not just the current thread.

<img width="1888" height="504" alt="shot-mrwgwdn7" src="https://github.com/user-attachments/assets/2e4f2de3-7447-4beb-993f-2222d8e08f3d" />

## The problem

Pi's built-in statusline sums cost from the current session's own message history only. If you use a subagent extension (e.g. one that spawns background workers, reviewers, researchers, etc.), those subagent sessions are written to their own nested session files and are invisible to the built-in cost total — so the number in your statusline can understate what a task actually cost by a wide margin.

## What this does

Subagent sessions get linked back to their parent chat in one of two ways, and this extension walks both to a fixed point:

- **Nested descendants** — fan-out/background subagents whose session files live under `<root-session>/**/session.jsonl` (a directory named after the parent session's own file, sans extension).
- **Flat siblings with a `parentSession` header** — single-shot/consult-style subagents whose session file sits next to the parent as a plain top-level `.jsonl`, but whose first line (`type: "session"`) carries a `parentSession` field pointing back to the parent's file path.

Either kind can itself parent the other kind, so discovery keeps expanding from both mechanisms until nothing new is found, then:

- Sums `usage.cost.total` across the root session and every descendant found this way.
- Adds an `incl $X.XX` segment to the statusline (via `ctx.ui.setStatus`) whenever descendant sessions exist — additive, next to the built-in direct-cost number, not a replacement.
- Refreshes on session start, at the end of every turn, and when the agent run ends — the same cadence the built-in cost figure updates at, not just once the whole task finishes.
- Adds a `/cost` command for an on-demand breakdown: direct cost, inclusive cost, and the number of subagent sessions folded in.

It intentionally does not attempt token-based cost *estimation* — it only sums `usage.cost.total` as already recorded in the session file. That field is itself a **client-side estimate** computed by the agent's model registry (input/output/cache token counts × that model's listed per-token price), not a number returned by your provider's billing API — so treat it as an estimate, not an authoritative bill. If your provider doesn't populate `usage.cost.total` at all, the inclusive total will read as `$0.00`.

## Install

```bash
pi install npm:pi-inclusive-cost
```

or directly from source:

```bash
pi install git:github.com/serhii-chernenko/pi-inclusive-cost
```

Restart Pi, or run `/reload`.

## Commands

- `/cost` — direct vs. inclusive cost breakdown for the current chat, plus subagent session count.

## Known limitation: newer artifacts-only subagent storage isn't covered yet

`pi-subagents` has changed how it persists at least one subagent mode (parallel/fork batches) between versions. Older versions always wrote a full session file for every subagent invocation, nested or as a flat sibling — the two mechanisms above. A newer mode instead writes only to `<project-cwd>/.pi-subagents/artifacts/<runId>_<agent>_<index>_meta.json` (plus a `_transcript.jsonl` with a different record schema), with **no corresponding session file anywhere** — nested or sibling. That cost is currently invisible to this extension.

This wasn't skipped by accident: there's no reliable way to attribute a given artifacts file back to one specific chat. The only correlation lead found (a `session_info` entry naming the subagent, written into the parent's own session file) turns out to depend on the `pi-intercom` package being installed — not a safe thing to build a core feature on. A worktree-wide sum without that correlation would also reintroduce exactly the cross-chat over-counting problem this extension was built to avoid in the first place (multiple unrelated chats in the same project folder getting lumped together). Until there's a first-party, version-stable way to scope this correctly, it's left uncovered rather than shipped fragile or wrong.

## Don't expect this to match your provider's billing dashboard exactly

`usage.cost.total` is computed locally from token counts and a local price table — it is not your provider's authoritative bill. Even with accurate, current pricing, a locally-summed total can diverge from what your provider's own usage dashboard reports, for reasons outside this extension's control: reporting lag on the provider's side, per-request billing multipliers instead of per-token metering, or negotiated/enterprise rates that differ from the public price list. If you need a number that reconciles with billing, treat this as a fast local signal, not a substitute for your provider's own dashboard.

For a full project-wide audit across every chat (not just the current one), use a dedicated usage-dashboard tool — this extension is meant for a quick, live, per-chat signal in the statusline.

## Releases

Bump `version` in `package.json`, commit, then push a matching tag:

```bash
git tag v0.1.3
git push origin main v0.1.3
```

The tag workflow type-checks, publishes to npm through npm Trusted Publishing, and creates a GitHub Release with generated notes. After claiming the package name with an initial manual publish, configure npm's Trusted Publisher for GitHub repository `serhii-chernenko/pi-inclusive-cost` and workflow filename `publish.yml`. Subsequent matching version tags publish without a stored npm token.

## License

MIT
