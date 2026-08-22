import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Run } from "./crawler.js";
import { writeReport } from "./report.js";
import { RunConfigSchema, BrowserSchema } from "./config.js";
import { checkCdp, resolveCdpEndpoint, resolveHeaders } from "./neko.js";

/**
 * The QA-crawler MCP server.
 *
 * The DETERMINISTIC machinery — the frontier, dedup, replay, the ledger, the checks — lives in code
 * (crawler.ts). The model calls these tools for JUDGMENT: which node next, does behaviour match intent,
 * is this a real issue. That split is the whole point: control flow is deterministic (so nothing is
 * skipped or forgotten), judgment is the model's (so subtle bugs are caught).
 */
const runs = new Map<string, Run>();

function ok(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}

const server = new McpServer({ name: "qa-crawler", version: "1.0.0" });

server.tool(
  "qa_browser_check",
  "Verify a browser transport before a run. For neko/cdp mode, confirms the Neko/CDP endpoint (local or remote) is reachable and reports which browser is on the other end. Call this first when using Neko.",
  { browser: z.record(z.any()).describe("A browser config: { mode: neko|cdp, cdpEndpoint, headers }.") },
  async ({ browser }) => {
    const b = BrowserSchema.parse(browser ?? {});
    if (b.mode === "launch") return ok({ mode: "launch", note: "local headless Chromium — nothing to check." });
    const endpoint = resolveCdpEndpoint(b);
    const result = await checkCdp(endpoint, resolveHeaders(b.headers));
    return ok({ mode: b.mode, ...result });
  },
);

server.tool(
  "qa_run_init",
  "Start (or resume) a QA run from a config. Launches the browser, logs in each actor, seeds the frontier. Returns the runId — pass it to every other tool.",
  { config: z.record(z.any()).describe("A RunConfig object: target, actors, scope, tiers, checks, viewports.") },
  async ({ config }) => {
    const run = await Run.create(config);
    runs.set(run.id, run);
    return ok({ runId: run.id, status: run.ledger.status(run.id), runDir: run.ledger.runDir });
  },
);

server.tool(
  "qa_crawl_auto",
  "Run the full DETERMINISTIC crawl to completion: map every reachable node, run every engine check, record verdicts + findings. Use this for the baseline pass, then augment with qa_crawl_next for judgment.",
  { runId: z.string() },
  async ({ runId }) => {
    const run = runs.get(runId);
    if (!run) return ok({ error: "unknown runId — call qa_run_init first" });
    let count = 0;
    await run.crawlAuto(() => count++);
    run.writeSitemap();
    const rep = writeReport(run.ledger, runId);
    return ok({ crawled: count, status: run.ledger.status(runId), report: rep });
  },
);

server.tool(
  "qa_crawl_next",
  "Pop the next frontier node (deterministic order: T1 first, then shallowest), inspect it, and return everything needed to JUDGE it: the observation, the archetypes, the playbook checklist, and the engine's automatic findings. The engine sets a provisional verdict; override it with qa_record_verdict after judging.",
  { runId: z.string() },
  async ({ runId }) => {
    const run = runs.get(runId);
    if (!run) return ok({ error: "unknown runId" });
    const next = await run.crawlNext();
    if (!next) return ok({ done: true, status: run.ledger.status(runId) });
    // Trim the observation for context economy — full evidence is on disk.
    const { node, observation, archetypes, playbook, engineFindings } = next;
    return ok({
      node: { id: node.id, actor: node.actor, url: node.url, tier: node.tier, depth: node.depth },
      archetypes,
      playbook,
      observation: {
        title: observation.title,
        httpStatus: observation.httpStatus,
        controlCount: observation.controls.length,
        controls: observation.controls.slice(0, 60),
        consoleErrors: observation.consoleErrors,
        overflow: observation.overflow,
        screenshot: observation.screenshotPath,
      },
      engineFindings,
      remaining: run.ledger.status(runId).notTested.length,
    });
  },
);

server.tool(
  "qa_record_verdict",
  "Record the model's judged verdict for a node (overrides the engine's provisional one). Use after applying the playbook and deciding pass/fail/blocked.",
  {
    runId: z.string(),
    nodeId: z.string(),
    verdict: z.enum(["passed", "failed", "blocked", "skipped"]),
    notes: z.string().optional(),
  },
  async ({ runId, nodeId, verdict, notes }) => {
    const run = runs.get(runId);
    if (!run) return ok({ error: "unknown runId" });
    run.ledger.setStatus(nodeId, verdict, notes ? { notes } : {});
    return ok({ nodeId, verdict, status: run.ledger.status(runId) });
  },
);

server.tool(
  "qa_save_finding",
  "Record a defect the model found by judgment (beyond the engine's automatic checks). Include severity, a reproduction, expected vs actual.",
  {
    runId: z.string(),
    nodeId: z.string().optional(),
    severity: z.enum(["S1", "S2", "S3", "S4", "S5"]),
    category: z.string(),
    title: z.string(),
    detail: z.string(),
    expected: z.string().optional(),
    actual: z.string().optional(),
    repro: z.array(z.string()).default([]),
  },
  async (a) => {
    const run = runs.get(a.runId);
    if (!run) return ok({ error: "unknown runId" });
    const id = "F-" + Math.random().toString(36).slice(2, 10);
    run.ledger.addFinding({
      id,
      run_id: a.runId,
      node_id: a.nodeId ?? null,
      severity: a.severity,
      category: a.category,
      title: a.title,
      detail: a.detail,
      expected: a.expected ?? null,
      actual: a.actual ?? null,
      repro: JSON.stringify(a.repro),
      evidence: "{}",
    });
    return ok({ findingId: id });
  },
);

server.tool(
  "qa_replay_to",
  "Navigate the actor's browser back to a node via its recorded anchor→node path, so the model can then interact with it (qa_act / qa_observe). This is how the crawler 'backtracks' in a stateful app.",
  { runId: z.string(), nodeId: z.string() },
  async ({ runId, nodeId }) => {
    const run = runs.get(runId);
    if (!run) return ok({ error: "unknown runId" });
    const node = run.ledger.allNodes(runId).find((n) => n.id === nodeId);
    if (!node) return ok({ error: "unknown nodeId" });
    const obs = await run.replayTo(node);
    return ok({ url: obs.url, title: obs.title, controls: obs.controls.slice(0, 60) });
  },
);

server.tool(
  "qa_act",
  "Perform ONE observable interaction on the current page (click/fill/select/press). Do-no-harm: never drive destructive controls (delete/pay/confirm) unless the run config explicitly allows it.",
  {
    runId: z.string(),
    actor: z.string(),
    kind: z.enum(["click", "fill", "select", "press"]),
    target: z.string().describe("CSS selector or `role:name` (e.g. `button:Save`)"),
    value: z.string().optional(),
  },
  async (a) => {
    const run = runs.get(a.runId);
    if (!run) return ok({ error: "unknown runId" });
    const session = (run as unknown as { sessions: Map<string, { act: (x: unknown) => Promise<void>; observe: (o: unknown) => Promise<unknown> }> }).sessions.get(a.actor);
    if (!session) return ok({ error: `no session for actor ${a.actor}` });
    await session.act({ kind: a.kind, target: a.target, value: a.value });
    const obs = await session.observe({ screenshot: false });
    return ok({ acted: true, now: obs });
  },
);

server.tool(
  "qa_status",
  "Coverage snapshot: totals, per-status counts, findings by severity, and the not-tested list (INV-5). Read this to resume after any interruption.",
  { runId: z.string() },
  async ({ runId }) => {
    const run = runs.get(runId);
    if (!run) return ok({ error: "unknown runId" });
    return ok(run.ledger.status(runId));
  },
);

server.tool(
  "qa_report",
  "Write the HTML + JSON report and the sitemap for the run; returns their paths.",
  { runId: z.string() },
  async ({ runId }) => {
    const run = runs.get(runId);
    if (!run) return ok({ error: "unknown runId" });
    const sitemap = run.writeSitemap();
    const rep = writeReport(run.ledger, runId);
    return ok({ ...rep, sitemap });
  },
);

server.tool(
  "qa_close",
  "Close the browser and finalize the run. Call when done (the ledger on disk remains for later inspection/resume).",
  { runId: z.string() },
  async ({ runId }) => {
    const run = runs.get(runId);
    if (!run) return ok({ error: "unknown runId" });
    await run.close();
    runs.delete(runId);
    return ok({ closed: true });
  },
);

// Expose the config schema as a resource so agents can see the exact shape.
server.resource("qa-config-schema", "qa://config-schema", async () => ({
  contents: [{ uri: "qa://config-schema", mimeType: "application/json", text: JSON.stringify(zodToPlain(RunConfigSchema), null, 2) }],
}));

function zodToPlain(_s: unknown): Record<string, string> {
  return {
    target: "string (url, required)",
    name: "string",
    actors: "[{ id, kind: anonymous|authenticated, auth?: { loginUrl, steps:[{target,action,value}], successUrlIncludes, storageStatePath } }]",
    scope: "{ include:[glob], exclude:[glob], maxDepth, maxNodes, sameOriginOnly }",
    tiers: "[{ pattern: glob, tier: T1|T2|T3 }]",
    checks: "{ http, console, brokenLinks, overflow, axe, formProbing, screenshot }",
    viewports: "[{ label, w, h }]",
    headless: "boolean",
  };
}

const transport = new StdioServerTransport();
await server.connect(transport);
