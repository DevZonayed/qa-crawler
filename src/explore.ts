import type { ControlSnapshot, Observation, ActorSession } from "./browser.js";
import type { ExploreOpts } from "./config.js";

/**
 * Action-driven state discovery — the fix for single-state coverage.
 *
 * Link-following sees each route only in its initial state. Real apps hide most of their surface behind
 * a click: "Add customer" opens a modal, a tab swaps a panel, "Show filters" reveals a form. None of it
 * is reachable by URL, so none of it was ever covered.
 *
 * The rule that keeps this safe is ALLOW-LIST FIRST: a control is clicked only when its label reads like
 * an opener AND does not read like an action with consequences. Everything that spends money, sends
 * mail, files to a tax authority, deletes, approves, or disconnects is refused — including anything the
 * caller adds via `explore.deny`. When in doubt, we do not click (INV-6).
 */

/** Labels that reveal UI without committing anything. */
const OPENERS =
  /^(add|new|create|open|edit|view|show|details?|expand|more|options?|manage|filter|search|configure|customi[sz]e|select|choose|browse|preview)\b/i;

/**
 * Labels we NEVER click. Deliberately broad — a false refusal costs a little coverage, a false click
 * can charge a card, email a client, or file a return.
 */
const DESTRUCTIVE =
  /\b(delete|remove|archive|destroy|drop|clear|purge|reset|revoke|disconnect|unlink|deactivate|suspend|disable|cancel|close\s+(the\s+)?(year|period|account)|pay|purchase|buy|checkout|charge|refund|transfer|withdraw|submit|confirm|approve|reject|authori[sz]e|sign|send|email|invite|file|publish|post\b|finali[sz]e|lock|reverse|void|upgrade|downgrade|subscribe|unsubscribe|import|export|download|upload|log\s?out|sign\s?out|switch|impersonate)\b/i;

export interface Opener {
  control: ControlSnapshot;
  /** Short, stable slug used in the state node's id. */
  slug: string;
}

/** Pick the safe, state-revealing controls on the current screen, best-first. */
export function findOpeners(obs: Observation, opts: ExploreOpts): Opener[] {
  const extraDeny = opts.deny.map((d) => new RegExp(d, "i"));
  const extraAllow = opts.allow.map((a) => new RegExp(a, "i"));
  const out: Opener[] = [];
  const seen = new Set<string>();

  for (const c of obs.controls) {
    // Only in-page controls. Links are the link-crawler's job; a real <a href> navigates.
    if (c.href) continue;
    if (!["button", "tab", "menuitem"].includes(c.role)) continue;
    const name = (c.name || "").trim();
    if (!name || name.length > 40) continue;

    if (DESTRUCTIVE.test(name) || extraDeny.some((r) => r.test(name))) continue;
    const isOpener = OPENERS.test(name) || extraAllow.some((r) => r.test(name)) || c.role === "tab";
    if (!isOpener) continue;

    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push({ control: c, slug });
  }
  // Tabs first (cheapest, safest, usually the biggest hidden surface), then openers.
  return out.sort((a, b) => (a.control.role === "tab" ? -1 : 0) - (b.control.role === "tab" ? -1 : 0));
}

/** Did clicking actually reveal something new worth treating as its own node? */
export function revealedNewState(before: Observation, after: Observation): boolean {
  if (after.url !== before.url) return false; // it navigated — the link crawler owns that
  if (after.dialogOpen && !before.dialogOpen) return true; // a modal opened
  if (after.formCount > before.formCount) return true; // a form appeared
  if (after.controls.length >= before.controls.length + 3) return true; // a panel of controls appeared
  if (after.tableCount > before.tableCount) return true; // a table appeared
  return false;
}

/**
 * Try one opener: click it, see what it revealed, then restore the screen so the next probe starts
 * from the same baseline. Never throws — a control that will not click is simply not a state.
 */
export async function probeOpener(
  session: ActorSession,
  baseUrl: string,
  before: Observation,
  opener: Opener,
): Promise<{ revealed: boolean; after?: Observation }> {
  try {
    await session.act({ kind: "click", target: opener.control.selector });
    const after = await session.observe({ screenshot: false });
    const revealed = revealedNewState(before, after);
    // Restore: close a modal politely, else re-load the base URL.
    if (after.dialogOpen) await session.page.keyboard.press("Escape").catch(() => {});
    if (session.page.url() !== baseUrl) await session.goto(baseUrl);
    return { revealed, after };
  } catch {
    return { revealed: false };
  }
}
