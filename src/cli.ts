#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Run } from "./crawler.js";
import { writeReport } from "./report.js";

/**
 * Standalone CLI — runs the deterministic crawl with no agent at all, so the tool is a complete
 * application on its own:  qa-crawl ./config.json   |   qa-crawl --url https://example.com
 * The MCP server (index.ts) adds the model-in-loop judgment layer on top of exactly this engine.
 */
async function main() {
  const args = process.argv.slice(2);
  let config: unknown;
  const urlIdx = args.indexOf("--url");
  if (urlIdx >= 0 && args[urlIdx + 1]) {
    config = { name: "cli", target: args[urlIdx + 1], actors: [{ id: "anonymous", kind: "anonymous" }] };
  } else if (args[0]) {
    config = JSON.parse(readFileSync(args[0], "utf8"));
  } else {
    console.error("usage: qa-crawl <config.json>   |   qa-crawl --url <target>");
    process.exit(1);
  }

  const run = await Run.create(config);
  console.error(`▶ run ${run.id} — crawling ${(config as { target: string }).target}`);
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
}

main().catch((e) => {
  console.error("qa-crawl failed:", e);
  process.exit(1);
});
