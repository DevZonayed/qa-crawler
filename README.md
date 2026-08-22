# QA Crawler

An autonomous QA **coverage crawler** for owned web apps. It treats testing as the *inverse* of solving
a maze: a maze-solver hunts one hidden exit and throws dead ends away; this **maps the whole app and
inspects every node**, and the dead ends *are* the findings. It works with full codebase access, client
only, or none — the access level changes the *method*, never the *standard of proof*.

Three ways to use the exact same engine:

1. **CLI** — a complete application on its own: crawl a site, get a report. No agent needed.
2. **MCP server** — drop the engine into *any* MCP-capable AI agent; the model adds judgment on top of the deterministic crawl.
3. **Claude Code plugin** — the packaged bundle: the MCP engine + a skill (the operating standard) + a slash command + orchestrator/worker subagents for scale.

## Why it's built this way

**Deterministic machinery in code; judgment in the model.** The frontier, dedup, anchor→node replay,
the coverage ledger, and the automatic checks live in TypeScript (they must be deterministic, or things
get skipped and forgotten). The *judgment* — is this a real issue, what was the correct result, what are
a flow's branches — is the model's job. The two never substitute for each other.

The design rules (the "why") are in the companion documents *The Problem-Seeker's Standard* and *The
Golden QA Session*. The short version — six invariants, enforced by the ledger:

1. Evidence over assertion · 2. Coverage is enumerated (not estimated) · 3. Access changes method, not standard · 4. Context is volatile, the ledger is durable · 5. Skips are loud · 6. Do no harm.

## Install

```bash
cd qa-crawler
pnpm install            # also runs `playwright install chromium`
pnpm build
```

Requires Node ≥ 20. `better-sqlite3` compiles a native module on install; `playwright` downloads Chromium.

## 1 · CLI (no agent)

```bash
# quick, anonymous crawl of a public site
node dist/cli.js --url https://example.com

# a full run from a config (auth, actors, tiers, viewports)
cp examples/config.example.json my-run.json      # edit target + creds (creds via ${ENV} vars)
QA_ADMIN_EMAIL=... QA_ADMIN_PASSWORD=... node dist/cli.js my-run.json
```

Output lands in `runs/<runId>/`: `ledger.db` (the resumable coverage ledger), `report.html`,
`report.json`, `sitemap.json`, and `evidence/*.png`. The run is resumable — the ledger is the truth.

**What the deterministic pass finds on its own:** non-2xx pages behind a rendered screen, console
errors, failed network requests, broken same-origin links, horizontal overflow at each viewport,
axe-core accessibility violations (mapped to severities), unlabelled form fields, unmasked password
fields, and missing password-recovery paths — plus a full per-screen control inventory so *nothing is
silently skipped*.

## 2 · MCP server (any agent)

Point an MCP client at the built server:

```jsonc
// .mcp.json in another project
{ "mcpServers": { "qa-crawler": { "command": "node", "args": ["/abs/path/to/qa-crawler/dist/index.js"] } } }
```

Tools: `qa_run_init` · `qa_crawl_auto` · `qa_crawl_next` · `qa_record_verdict` · `qa_save_finding` ·
`qa_replay_to` · `qa_act` · `qa_status` · `qa_report` · `qa_close`. Resource `qa://config-schema`
describes the config. The agent runs `qa_crawl_auto` for the baseline, then loops `qa_crawl_next` to add
judgment, and resumes any interrupted run from `qa_status`.

## 3 · Claude Code plugin

The repo *is* the plugin (`.claude-plugin/plugin.json`). Install it (e.g. add this directory as a
plugin / to a marketplace), then:

```
/qa-crawl https://your-app.com              # complete audit
/qa-crawl https://your-app.com login        # just the login flow, deep
```

It loads the **qa-crawl skill** (the operating standard as a procedure), wires the **qa-crawler MCP**,
and can fan out via the **qa-orchestrator** → **qa-worker** subagents for apps too big for one context.

## Browser transport — Neko (watched), local or remote

By default the engine launches its own headless Chromium. For real QA you usually want **Neko** — a
streamed, visible Chrome you watch and can **take over mid-run** (to solve an MFA prompt or CAPTCHA),
then hand back. The engine drives it over CDP. Three modes (config `browser.mode`, or CLI flags):

```bash
node dist/cli.js --url https://your-app.com --neko            # local Neko at http://127.0.0.1:9223
node dist/cli.js my-run.json --cdp http://127.0.0.1:9223       # any CDP endpoint
node dist/cli.js --url https://your-app.com                    # launch (headless, default)
```

```jsonc
// in a run config
"browser": {
  "mode": "neko",                       // launch | neko | cdp
  "cdpEndpoint": "http://127.0.0.1:9223",// neko default; set for cdp/remote
  "headers": { "Authorization": "Bearer ${NEKO_TOKEN}" }, // optional, for a remote behind auth
  "reuseVisibleContext": true,          // run in the tab the user is watching
  "bringToFront": true,                 // keep the acted tab on the shared screen
  "slowMo": 250                         // ms per action, so a human can follow
}
```

**Adding a REMOTE Neko.** Neko's CDP binds to loopback on its host, so expose it to the engine one of
two ways, then point `cdpEndpoint` at it:

- **SSH tunnel (simplest, keeps it private):** `ssh -N -L 9223:127.0.0.1:9223 user@remote-neko-host`,
  then keep `cdpEndpoint: "http://127.0.0.1:9223"` — the engine talks to the remote Neko through the
  tunnel. Set `QA_NEKO_CDP=http://127.0.0.1:9223` for the Playwright-MCP block too.
- **Reverse proxy with auth:** expose the remote CDP behind TLS + a token, set
  `mode: "cdp"`, `cdpEndpoint: "https://neko.example.com/cdp"`, and `headers` for the token.

Verify before a run: the MCP tool **`qa_browser_check`** (or `curl http://127.0.0.1:9223/json/version`)
confirms the endpoint and reports which browser is on the other end.

**Safe by design:** a CDP-connected Neko is **never killed** on close — the engine disconnects (closes
its socket) and leaves your Neko running, exactly as the `neko` CLI does.

### Playwright-MCP on the same Neko

The plugin also wires **`@playwright/mcp`** to the *same* Neko over CDP, so the agent gets generic
browser tools (navigate / click / snapshot) — visible in Neko — for ad-hoc steps alongside the
qa-crawler engine. Set `QA_NEKO_CDP` to a remote endpoint to point both at a remote Neko. Remove the
`playwright` block from `.mcp.json` / `plugin.json` to use the engine alone.

## The traversal model (the "inverted maze")

| | Maze solver | QA crawler (this) |
|---|---|---|
| Goal | one hidden exit | visit **every** node + edge |
| Dead ends | discarded | **recorded as findings** |
| The map | irrelevant once solved | **is a deliverable** (`sitemap.json`) |
| Stop when | exit found | **frontier empty** (`queued=0`) |
| Backtrack | walk back a corridor | **replay a path from an anchor** (`qa_replay_to`) |

Graph expansion follows same-origin **links** (safe, deterministic) and inventories **every** control.
Exercising non-link controls (buttons, forms, multi-step flows) — which can be destructive — is the
model-in-loop layer's job via `qa_replay_to → qa_act`, gated by do-no-harm.

## Access levels

- **No code:** the crawl *builds* the sitemap; oracles are the product's own copy + standards (WCAG/HTTP) + differential (role A vs B).
- **Client code:** seed `scope.include` and `tiers` from the route manifest, then **diff** it against the crawled `sitemap.json` — anything in source but never crawled is unreachable (a finding) or a gate to verify.
- **Client + server code:** add domain oracles — attempt illegal state transitions, cross-tenant access, and cross-check a figure on two screens or against the DB. Tail server logs during the run to catch "success over a 500."

## Extending the pattern memory

`patterns/archetypes.json` is the catalogue of screen archetypes and their playbooks; `src/archetypes.ts`
holds the matchers. Teach a new pattern once (a matcher + a playbook) and every later screen and every
later run recognises it. That is the "pattern memory that grows."

## Layout

```
src/            engine: config · state (dedup) · ledger (sqlite) · browser (playwright) ·
                archetypes · checks · crawler (frontier+replay) · report · index (MCP) · cli
patterns/       the growable archetype + playbook catalogue
skills/qa-crawl/ the operating standard as an agent procedure
commands/       /qa-crawl slash command
agents/         qa-orchestrator + qa-worker subagents (scale)
examples/       a worked config
```

## Honest limits (v1)

- Graph expansion is **link-based**; action-only states (reached only by clicking a button) are covered by the model-in-loop layer, not the auto-crawl. Full action-path replay is the natural next increment (the `replay_path` schema already supports it).
- The automatic checks are the trustworthy *floor*; behavioural correctness ("does it do what it claims") still needs the model. That split is intentional, not a gap.
- Visual regression is overflow + screenshots today; wire a screenshot-diff baseline for pixel regressions.
