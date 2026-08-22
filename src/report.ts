import { writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Ledger } from "./ledger.js";

/** Render the run to a self-contained HTML report + a machine-readable JSON, both in the run dir. */
export function writeReport(ledger: Ledger, runId: string): { html: string; json: string } {
  const st = ledger.status(runId);
  const nodes = ledger.allNodes(runId);
  const findings = ledger.allFindings(runId);
  const sev = (s: string) => ({ S1: "Blocker", S2: "Critical", S3: "Major", S4: "Minor", S5: "Trivial" })[s] ?? s;
  const rel = (p: string) => (p ? relative(ledger.runDir, p) : "");

  const jsonPath = join(ledger.runDir, "report.json");
  writeFileSync(jsonPath, JSON.stringify({ runId, summary: st, findings, nodes }, null, 2));

  const findingRows = findings
    .map((f) => {
      const ev = JSON.parse(f.evidence || "{}") as Record<string, string>;
      const shot = Object.entries(ev).find(([k]) => k.startsWith("screenshot"));
      return `<tr class="sev-${f.severity}">
        <td><span class="pill p-${f.severity}">${f.severity} ${sev(f.severity)}</span></td>
        <td><b>${esc(f.title)}</b><div class="detail">${esc(f.detail).slice(0, 400)}</div>
            ${f.expected ? `<div class="ea">expected <code>${esc(f.expected)}</code> · actual <code>${esc(f.actual ?? "")}</code></div>` : ""}</td>
        <td class="mono">${esc(f.category)}</td>
        <td class="mono">${shot ? `<a href="${esc(rel(shot[1]))}">shot</a>` : ""}</td>
      </tr>`;
    })
    .join("");

  const nodeRows = nodes
    .map(
      (n) => `<tr class="st-${n.status}"><td class="mono">${esc(n.actor)}</td><td class="mono">${esc(n.route_template.replace(/^https?:\/\/[^/]+/, "") || "/")}</td>
      <td><span class="pill tier">${n.tier}</span></td><td><span class="pill s-${n.status}">${n.status}</span></td>
      <td class="num">${n.controls_count}</td><td class="mono small">${esc(JSON.parse(n.archetypes).join(", "))}</td></tr>`,
    )
    .join("");

  const notTested = st.notTested.length
    ? `<ul>${st.notTested.map((n) => `<li class="mono"><span class="pill s-${n.status}">${n.status}</span> ${esc(n.url)}</li>`).join("")}</ul>`
    : `<p class="ok">Nothing untested — every node has a verdict.</p>`;

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>QA report · ${esc(runId)}</title><style>
:root{--bg:#f4f6fa;--surface:#fff;--sunken:#e9edf4;--ink:#111725;--muted:#4a5265;--line:#d5deea;--accent:#2247d8;
--S1:#c0281c;--S1b:#fbe5e1;--S2:#b1490b;--S2b:#fbecdb;--S3:#8a6300;--S3b:#f8efce;--S4:#455170;--S4b:#e7ecf4;--S5:#1c6b3e;--S5b:#dff0e6;}
@media(prefers-color-scheme:dark){:root{--bg:#0c0f16;--surface:#141a24;--sunken:#1c2431;--ink:#e8edf5;--muted:#a7b2c5;--line:#28313f;--accent:#7089ff;
--S1b:#37191490;--S2b:#33210f90;--S3b:#2e260f90;--S4b:#1e2637;--S5b:#132a1d90;}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1040px;margin:0 auto;padding:32px 20px 80px}h1{font-size:1.9rem;margin:0}h2{margin:44px 0 10px;font-size:1.2rem;border-top:1px solid var(--line);padding-top:18px}
.meta{color:var(--muted);font-family:ui-monospace,monospace;font-size:.82rem;margin-top:6px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:18px 0}
.card{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:14px}.card .n{font-size:1.7rem;font-weight:700}.card .l{color:var(--muted);font-size:.8rem}
table{width:100%;border-collapse:collapse;font-size:.86rem;background:var(--surface);border:1px solid var(--line);border-radius:10px;overflow:hidden}
th,td{text-align:left;padding:9px 11px;border-top:1px solid var(--line);vertical-align:top}th{background:var(--sunken);font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
.detail{color:var(--muted);font-size:.82rem;margin-top:3px;white-space:pre-wrap}.ea{font-size:.78rem;margin-top:3px}
.pill{display:inline-block;font-family:ui-monospace,monospace;font-size:.7rem;padding:.12em .5em;border-radius:5px;white-space:nowrap}
.p-S1{background:var(--S1b);color:var(--S1)}.p-S2{background:var(--S2b);color:var(--S2)}.p-S3{background:var(--S3b);color:var(--S3)}.p-S4{background:var(--S4b);color:var(--S4)}.p-S5{background:var(--S5b);color:var(--S5)}
.tier{background:var(--sunken);color:var(--muted)}.s-passed{background:var(--S5b);color:var(--S5)}.s-failed{background:var(--S1b);color:var(--S1)}.s-queued,.s-blocked,.s-skipped,.s-in_progress{background:var(--S3b);color:var(--S3)}
.mono{font-family:ui-monospace,monospace;font-size:.82rem}.small{font-size:.74rem}.num{text-align:right;font-variant-numeric:tabular-nums}
code{background:var(--sunken);padding:.05em .3em;border-radius:4px;font-size:.85em}a{color:var(--accent)}.ok{color:var(--S5)}
.tablewrap{overflow-x:auto;margin:12px 0}
</style></head><body><main>
<h1>QA coverage report</h1><div class="meta">${esc(runId)} · ${new Date().toISOString()}</div>
<div class="cards">
<div class="card"><div class="n">${st.coveragePct}%</div><div class="l">coverage (${(st.byStatus.passed ?? 0) + (st.byStatus.failed ?? 0)}/${st.total} nodes)</div></div>
<div class="card"><div class="n">${findings.length}</div><div class="l">findings</div></div>
<div class="card"><div class="n" style="color:var(--S1)">${st.findingsBySeverity.S1 ?? 0}</div><div class="l">blockers (S1)</div></div>
<div class="card"><div class="n" style="color:var(--S2)">${st.findingsBySeverity.S2 ?? 0}</div><div class="l">critical (S2)</div></div>
<div class="card"><div class="n">${st.notTested.length}</div><div class="l">not tested</div></div>
</div>
<h2>Findings (most severe first)</h2><div class="tablewrap"><table><thead><tr><th>Severity</th><th>Finding</th><th>Category</th><th>Evidence</th></tr></thead><tbody>${findingRows || `<tr><td colspan=4 class="ok">No findings.</td></tr>`}</tbody></table></div>
<h2>Not tested (INV-5 — surfaced, never hidden)</h2>${notTested}
<h2>Coverage map — every node &amp; its verdict</h2><div class="tablewrap"><table><thead><tr><th>Actor</th><th>Route</th><th>Tier</th><th>Status</th><th>Controls</th><th>Archetypes</th></tr></thead><tbody>${nodeRows}</tbody></table></div>
</main></body></html>`;

  const htmlPath = join(ledger.runDir, "report.html");
  writeFileSync(htmlPath, html);
  return { html: htmlPath, json: jsonPath };
}

function esc(s: string): string {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
