# pi-inclusive-cost

A [Pi coding agent](https://pi.dev) extension that shows session cost **including subagent sessions**, not just the current thread.

## The problem

Pi's built-in statusline sums cost from the current session's own message history only. If you use a subagent extension (e.g. one that spawns background workers, reviewers, researchers, etc.), those subagent sessions are written to their own nested session files and are invisible to the built-in cost total — so the number in your statusline can understate what a task actually cost by a wide margin.

## What this does

Subagent sessions get linked back to their parent chat in one of two ways, and this extension walks both to a fixed point:

- **Nested descendants** — fan-out/background subagents whose session files live under `<root-session>/**/session.jsonl` (a directory named after the parent session's own file, sans extension).
- **Flat siblings with a `parentSession` header** — single-shot/consult-style subagents whose session file sits next to the parent as a plain top-level `.jsonl`, but whose first line (`type: "session"`) carries a `parentSession` field pointing back to the parent's file path.

Either kind can itself parent the other kind, so discovery keeps expanding from both mechanisms until nothing new is found, then:

- Sums `usage.cost.total` across the root session and every descendant found this way.
- Adds an `incl $X.XX` segment to the statusline (via `ctx.ui.setStatus`) whenever descendant sessions exist — additive, next to the built-in direct-cost number, not a replacement.
- Adds a `/cost` command for an on-demand breakdown: direct cost, inclusive cost, and the number of subagent sessions folded in.

It intentionally does not attempt token-based cost *estimation* — it only sums `usage.cost.total` as already recorded in the session file. That field is itself a **client-side estimate** computed by the agent's model registry (input/output/cache token counts × that model's listed per-token price), not a number returned by your provider's billing API — so treat it as an estimate, not an authoritative bill. If your provider doesn't populate `usage.cost.total` at all, the inclusive total will read as `$0.00`.

## Install

```bash
pi install git:github.com/serhii-chernenko/pi-inclusive-cost
```

Restart Pi, or run `/reload`.

## Commands

- `/cost` — direct vs. inclusive cost breakdown for the current chat, plus subagent session count.

## Don't expect this to match your provider's billing dashboard exactly

`usage.cost.total` is computed locally from token counts and a local price table — it is not your provider's authoritative bill. Even with accurate, current pricing, a locally-summed total can diverge from what your provider's own usage dashboard reports, for reasons outside this extension's control: reporting lag on the provider's side, per-request billing multipliers instead of per-token metering, or negotiated/enterprise rates that differ from the public price list. If you need a number that reconciles with billing, treat this as a fast local signal, not a substitute for your provider's own dashboard.

For a full project-wide audit across every chat (not just the current one), use a dedicated usage-dashboard tool — this extension is meant for a quick, live, per-chat signal in the statusline.

## License

MIT
