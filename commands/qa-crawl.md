---
description: Run a QA coverage crawl against a target URL (full audit or a named flow) using the qa-crawler engine + judgment layer.
argument-hint: <target-url> [flow: login|checkout|...] [scope hints]
---

Invoke the **qa-crawl** skill and run a QA pass against: **$ARGUMENTS**

Steps:
1. Load the `qa-crawl` skill and follow its procedure exactly.
2. Clarify only what you can't infer: access level (no code / client / client+server), whether this is a **complete** audit or a **partial flow**, credentials/roles to test, and where the oracle comes from. If the argument names a flow, scope to that flow (partial, depth-first); otherwise do a complete crawl.
3. Build the RunConfig (read `qa://config-schema` for the shape), `qa_run_init`, `qa_crawl_auto` for the baseline, then the `qa_crawl_next` judgment loop.
4. Finish with `qa_report` and present: scoreboard → findings (S1→S5, with repro + evidence) → the not-tested list with reasons → the coverage map. Then `qa_close`.

Respect the six invariants in the skill — especially: never claim coverage the ledger doesn't show, and never bypass auth or drive destructive controls.
