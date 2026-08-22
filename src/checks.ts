import type { Observation, ActorSession } from "./browser.js";
import type { Checks, RunConfig } from "./config.js";
import type { Severity } from "./ledger.js";
import { sameOrigin, shortHash } from "./state.js";
import type { Archetype } from "./archetypes.js";

/** A finding produced by the deterministic engine, before it is written to the ledger. */
export interface RawFinding {
  severity: Severity;
  category: string;
  title: string;
  detail: string;
  expected?: string;
  actual?: string;
  evidence?: Record<string, unknown>;
}

const axeSeverity: Record<string, Severity> = { critical: "S2", serious: "S3", moderate: "S4", minor: "S5" };

/**
 * Link-check budget, shared for the lifetime of the process (one run). Without this the checker is a
 * request amplifier: the same nav links re-fetched on every node, which trips rate limiters and turns
 * the app's defensive 429s into bogus findings.
 */
const linkStatusCache = new Map<string, number>();
let linkChecksThisRun = 0;
const MAX_LINK_CHECKS_PER_NODE = 25;
const MAX_LINK_CHECKS_PER_RUN = 300;
const LINK_CHECK_PACE_MS = 120;

/** Reset the link budget between runs in the same process (the MCP server is long-lived). */
export function resetLinkBudget(): void {
  linkStatusCache.clear();
  linkChecksThisRun = 0;
}

/**
 * The deterministic check battery. Everything here is decidable in code — no model judgment — so it is
 * the trustworthy baseline that runs on every node. The model-in-loop layer ADDS judgment
 * (does behaviour match intent, is the UX wrong) on top of these facts; it does not replace them.
 */
export async function runChecks(
  session: ActorSession,
  obs: Observation,
  archetypes: Archetype[],
  config: RunConfig,
): Promise<RawFinding[]> {
  const checks: Checks = config.checks;
  const findings: RawFinding[] = [];

  // HTTP — a non-OK status behind a rendered screen is the classic "success over a 500".
  if (checks.http && obs.httpStatus != null && obs.httpStatus >= 400) {
    findings.push({
      severity: obs.httpStatus >= 500 ? "S1" : "S2",
      category: "http",
      title: `HTTP ${obs.httpStatus} on ${new URL(obs.url).pathname}`,
      detail: `The page returned ${obs.httpStatus} but still rendered. A user-visible screen over a failed response hides real errors.`,
      expected: "2xx/3xx",
      actual: String(obs.httpStatus),
    });
  }

  // Console errors — a clean UI over red console errors is a finding.
  if (checks.console && obs.consoleErrors.length) {
    findings.push({
      severity: "S3",
      category: "console",
      title: `${obs.consoleErrors.length} console error(s)`,
      detail: obs.consoleErrors.slice(0, 5).join("\n"),
    });
  }

  // Network failures during load.
  if (obs.networkFailures.length) {
    findings.push({
      severity: "S3",
      category: "network",
      title: `${obs.networkFailures.length} failed request(s) on load`,
      detail: obs.networkFailures.slice(0, 5).join("\n"),
    });
  }

  // Horizontal overflow — the page body scrolls sideways (responsive breakage).
  if (checks.overflow && obs.overflow) {
    // Reproduce-before-report: a symptom that vanishes on a second measurement is noise.
    const confirmed = await session.confirmOverflow();
    if (confirmed.overflow)
      findings.push({
        severity: "S4",
        category: "visual",
        title: "Horizontal overflow — the page scrolls sideways",
        detail: `documentElement.scrollWidth exceeds clientWidth by ${confirmed.px}px (confirmed twice), so content is cut off or the body scrolls horizontally.`,
        expected: "scrollWidth <= clientWidth",
        actual: `${confirmed.px}px of overflow`,
      });
  }

  // Broken same-origin links (dead controls / 404s the user would hit next).
  if (checks.brokenLinks) {
    // RUN-WIDE dedup: a nav link appears on every page, so a per-node `seen` set re-checked the same
    // handful of URLs on every node — ~25 requests x N nodes. On the first real run that request
    // amplification tripped the app's own rate limiter (429), and those 429s were then reported as
    // "console error" findings: the checker corrupting its own results. Now each URL is checked ONCE
    // per run, results are cached, and requests are paced.
    const targets = obs.links.filter((h) => sameOrigin(h, config.target)).slice(0, MAX_LINK_CHECKS_PER_NODE);
    for (const href of targets) {
      const key = href.split("#")[0]!;
      let status = linkStatusCache.get(key);
      if (status === undefined) {
        if (linkChecksThisRun >= MAX_LINK_CHECKS_PER_RUN) break;
        linkChecksThisRun++;
        status = await session.page
          .request.get(href, { maxRedirects: 3, timeout: 8000 })
          .then((r) => r.status())
          .catch(() => 0);
        linkStatusCache.set(key, status);
        await new Promise((r) => setTimeout(r, LINK_CHECK_PACE_MS)); // pace: never out-run the app
      } else {
        continue; // already checked (and reported, if broken) earlier in this run
      }
      if (status === 0 || status >= 400) {
        findings.push({
          severity: status >= 500 || status === 0 ? "S2" : "S3",
          category: "broken-link",
          title: `Link target ${status || "unreachable"}: ${new URL(href).pathname}`,
          detail: `A link on this page points to ${href}, which returned ${status || "no response"}.`,
        });
      }
    }
  }

  // Accessibility — axe-core violations mapped to severities.
  if (checks.axe) {
    const violations = await session.runAxe();
    for (const v of violations.slice(0, 20)) {
      findings.push({
        severity: axeSeverity[v.impact] ?? "S4",
        category: "a11y",
        title: `a11y: ${v.help} (${v.id})`,
        detail: `${v.nodes} element(s). e.g. \`${v.sample}\`. WCAG rule ${v.id}, impact ${v.impact}.`,
      });
    }
  }

  // Archetype-specific static inspections (non-destructive).
  if (archetypes.includes("login")) {
    const masked = await session.page.$eval('input[type="password"]', () => true).catch(() => false);
    if (!masked)
      findings.push({ severity: "S2", category: "login", title: "Password field is not masked", detail: "The login screen has no input[type=password] — the password may be visible as plain text." });
    const hasForgot = /forgot|reset/i.test(obs.bodyText);
    if (!hasForgot)
      findings.push({ severity: "S4", category: "login", title: "No password-recovery path on the login screen", detail: "No 'forgot password' affordance was found; users who forget are stuck." });
  }
  if (archetypes.includes("form") || archetypes.includes("signup")) {
    const unlabeled = await session.page
      .$$eval("input:not([type=hidden]):not([type=submit]):not([type=button]), select, textarea", (els) =>
        els.filter((el) => {
          const id = el.getAttribute("id");
          const hasLabel = id ? !!document.querySelector(`label[for="${CSS.escape(id)}"]`) : false;
          return !hasLabel && !el.getAttribute("aria-label") && !el.getAttribute("aria-labelledby") && !el.getAttribute("placeholder");
        }).length,
      )
      .catch(() => 0);
    if (unlabeled > 0)
      findings.push({ severity: "S3", category: "a11y", title: `${unlabeled} form field(s) with no accessible label`, detail: "Inputs without a <label for>, aria-label, aria-labelledby or placeholder are unusable with a screen reader." });
  }

  return findings;
}

/** Derive a stable finding id so re-runs dedupe instead of piling up. */
export function findingId(runId: string, nodeId: string, f: RawFinding): string {
  return "F-" + shortHash(runId, nodeId, f.category, f.title);
}
