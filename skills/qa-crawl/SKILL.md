---
name: qa-crawl
description: Use when asked to QA a web app — a full-coverage audit or a named flow (login/checkout/etc.), with or without codebase access. Drives the qa-crawler MCP engine (deterministic frontier + ledger + checks) and adds the model's judgment on top. Guarantees no control is silently skipped and survives long/compacted sessions by resuming from the ledger.
---

# QA Crawl — the operating standard, as a procedure

You are the judgment layer over a deterministic engine. The engine (the `qa-crawler` MCP server) owns
the frontier, dedup, replay, the coverage ledger, and the automatic checks. You own the parts only a
mind can do: deriving the oracle, judging whether a screen is *wrong*, and enumerating the branches of a
flow. **Never do the engine's job by hand** (don't track coverage in your head — that is what gets
skipped and forgotten). **Never let the engine do your job** (a green automatic check is not a pass for
"does it behave as intended").

## The six invariants (do not violate)

1. **Evidence over assertion.** "works"/"broken" needs an artifact (screenshot, DOM, response, repro). Never write "verified" from reading code.
2. **Coverage is enumerated.** Only claim "complete" when `qa_status` shows `queued=0` and `in_progress=0`.
3. **Access changes method, not standard.** Code is for deriving the checklist and root-causing — a pass is always taken at the user-visible boundary.
4. **Context is volatile; the ledger is durable.** After any reset, your FIRST action is `qa_status` — resume from it, never from memory.
5. **Skips are loud.** The not-tested list is a deliverable, never empty by omission.
6. **Do no harm.** Stay in the authorized scope; never bypass auth; never drive destructive controls (delete/pay/confirm) unless the config allows it.

## Procedure

### 0 — Browser transport (watchable, chosen per machine)
- Leave `browser.mode` at its default **`auto`** — it picks the right watchable browser for the machine: a reachable **Neko** (configured endpoint, `$QA_NEKO_CDP`, or local `127.0.0.1:9223`) on a server; otherwise a **launched Chromium, headed when a display exists** (a local computer: the user watches the real window — no Neko needed) and headless when not (CI).
- Call **`qa_browser_check`** before `qa_run_init` and TELL the user what it resolved to ("driving your local Chromium" vs "driving Neko at …"), so they know where to watch.
- Force a mode only when the situation demands it: `browser.mode = "cdp"` + `cdpEndpoint`/`headers` for a specific **remote Neko**; `mode: "launch"` (or `$QA_BROWSER=launch`) for unattended runs. Never bypass auth; if login needs a human step, pause and ask the user to take over in the watched browser, then continue.

### 1 — Plan (define steps first)
- Confirm the target, the access level (no code / client / client+server), the scope (partial flow vs complete), and where the **oracle** comes from (spec docs, user stories, or "the product's own copy is the contract").
- Build the config: `target`, `browser` (see step 0), `actors` (one per role/permission you can authenticate — anonymous first so register/forgot-password get covered), `scope` (include/exclude globs, maxDepth, maxNodes), `tiers` (T1 = auth/payments/mutations → exhaustive; T3 = static → smoke), `checks`, `viewports`.
- With client code: seed `scope.include` and `tiers` from the **route manifest** so the engine's crawl can be diffed against it (orphan/unreachable routes are findings).
- Call **`qa_run_init`** with the config → keep the `runId`.

### 2 — Baseline (deterministic, cheap, trustworthy)
- Call **`qa_crawl_auto`**. The engine maps every reachable node and runs the automatic battery (HTTP, console, broken links, overflow, axe a11y, per-viewport responsive, form-label checks). This is your floor of facts.

### 3 — Judgment pass (what only you can do)
- Loop **`qa_crawl_next`**. For each node it hands you the observation, the **archetypes**, the **playbook** for those archetypes, and the engine's findings. For each:
  - Apply the playbook with the oracle. Ask: does the behaviour match the intent/spec? Are the states (empty/loading/error) right? Is the copy consistent with what the control does?
  - To exercise non-link controls (buttons, forms, flows) use **`qa_replay_to`** → **`qa_act`** → `now` observation. Reproduce a suspected issue before reporting (kill flakes).
  - Real defect → **`qa_save_finding`** (severity S1–S5, expected vs actual, a reproduction). Then **`qa_record_verdict`** (`passed`/`failed`/`blocked`).
- For a **partial flow** run: after the baseline, enumerate the flow's branches (entry variants · each validation failure · each actor who can/can't · state branches · interruption: back/refresh/double-submit/timeout · exit branches) and drive each with `qa_replay_to`+`qa_act`. With code, derive the branch list from the flow's components/schema/state-machine so it is provably complete; without, saturate with the input battery and log the residual uncertainty.

### 4 — Diff & negative space
- With code: reconcile the route/feature manifest against the crawled sitemap (`qa://` sitemap / `qa_report`). Anything in source but never crawled is unreachable (a finding) or intentionally hidden (verify the gate).
- Without code: compare the product's *claimed* features (nav, docs, marketing) against what you could reach.

### 5 — Fix-and-resume (only if asked to fix)
- Capture the finding first. Fix, redeploy/reload, then **re-verify that node** through the UI. A fix can touch a shared component, so **re-queue neighbours** that share the route-prefix/archetype (regression ripple) rather than assuming forward progress is safe. Then continue `qa_crawl_next` from the frontier — never restart the whole crawl.

### 6 — Report
- `qa_status` must show `queued=0, in_progress=0` (or every remaining node explained). Call **`qa_report`** for the HTML+JSON. Present: verdict & scoreboard → findings triaged S1→S5 with repro+evidence → **the not-tested list with reasons** → the coverage map. Then `qa_close`.

## Resuming a long / compacted session
If your context was reset: call `qa_status` with the runId, read the not-tested list, and continue
`qa_crawl_next`. The run is idempotent — re-inspecting a done node is a no-op; an interrupted node stays
`in_progress` and is picked up again. You do not need to remember what you did; the ledger does.

## Scale (large apps)
For a big surface, don't hold it all yourself — use the **qa-orchestrator** subagent, which shards the
frontier into per-route/per-actor packets for **qa-worker** subagents; each worker fits one context and
writes to the shared ledger. See the agents in this plugin.
