#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Run } from "./crawler.js";
import { writeReport } from "./report.js";

/**
 * Standalone CLI — runs the deterministic crawl with no agent at all, so the tool is a complete
 * application on its own:  qa-crawl ./config.json   |   qa-crawl --url https://example.com
 * The MCP server (index.ts) adds the model-in-loop judgment layer on top of exactly this engine.
 */
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? "") : undefined;
}

/** Browser transport from CLI flags: --neko [endpoint] | --cdp <endpoint> | --headed. */
function browserFromArgs(args: string[]): Record<string, unknown> | undefined {
  if (args.includes("--neko")) {
    const ep = flag(args, "--neko");
    return { mode: "neko", ...(ep && ep.startsWith("http") ? { cdpEndpoint: ep } : {}) };
  }
  const cdp = flag(args, "--cdp");
  if (cdp) return { mode: "cdp", cdpEndpoint: cdp };
  if (args.includes("--headed")) return { mode: "launch" };
  return undefined;
}

async function main() {
  const args = process.argv.slice(2);
  let config: Record<string, unknown>;
  const url = flag(args, "--url");
  if (url) {
    config = { name: "cli", target: url, actors: [{ id: "anonymous", kind: "anonymous" }] };
  } else if (args[0] && !args[0].startsWith("--")) {
    config = JSON.parse(readFileSync(args[0], "utf8"));
  } else {
    console.error("usage: qa-crawl <config.json> [--neko|--cdp <endpoint>] [--resume <runId>]   |   qa-crawl --url <target> [--neko]");
    process.exit(1);
  }
  const browser = browserFromArgs(args);
  if (browser) config.browser = { ...(config.browser as object), ...browser };
  if (args.includes("--headed")) config.headless = false;

  // --resume <runId>: reopen runs/<runId>/ledger.db and continue from the frontier.
  const resumeId = flag(args, "--resume");
  const run = await Run.create(config, resumeId || undefined);
  if (resumeId) console.error(`↻ resuming ${resumeId} — ${run.resumedInterrupted} interrupted node(s) re-queued`);
  console.error(`▶ run ${run.id} — crawling ${(config as { target: string }).target} [browser: ${run.browserDescription}]`);
  let last = 0;
  await run.crawlAuto((node, i) => {
    if (i - last >= 1) {
      last = i;
      const st = run.ledger.status(run.id);
      console.error(`  [${i}] ${node.status.padEnd(8)} ${node.tier} ${node.url}  · ${st.coveragePct}% · ${Object.values(st.findingsBySeverity).reduce((a, b) => a + b, 0)} findings`);
    }
  });
  run.writeSitemap();
  const rep = writeReport(run.ledger, run.id);
  const st = run.ledger.status(run.id);
  await run.close();

  console.error(`\n✔ done — ${st.coveragePct}% coverage, ${st.total} nodes`);
  console.error(`  findings: ${JSON.stringify(st.findingsBySeverity)}`);
  console.error(`  not tested: ${st.notTested.length}`);
  console.error(`  report: ${rep.html}`);
  console.log(rep.html);
  // A CDP connection to Neko keeps the event loop alive. Ending the process closes the socket
  // (a disconnect) WITHOUT sending Browser.close — so a connected Neko keeps running. This is the
  // safe "disconnect, don't kill" behaviour.
  process.exit(0);
}

main().catch((e) => {
  console.error("qa-crawl failed:", e);
  process.exit(1);
});
