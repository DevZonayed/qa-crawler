import type { Observation } from "./browser.js";

/**
 * Archetype classification — the "pattern memory."
 *
 * The crawler recognises the KIND of screen it has landed on (login form, data table, CRUD list, …)
 * and applies that archetype's playbook. This is what stops the agent re-deriving "how do I test a
 * login form" on every screen, and — via archetype equivalence — lets the Nth instance of a pattern be
 * verified with a lighter check + a diff rather than the full battery. The registry is data (see
 * patterns/archetypes.json) so it GROWS: a new pattern encountered once is remembered for every later
 * screen and every later run.
 */

export type Archetype =
  | "login"
  | "signup"
  | "forgot-password"
  | "form"
  | "data-table"
  | "crud-list"
  | "search"
  | "modal"
  | "wizard"
  | "content";

const CREATE_WORDS = /\b(add|new|create|invite|upload)\b/i;
const WIZARD_WORDS = /\b(next|continue|step \d|back)\b/i;
const SEARCH_WORDS = /\b(search|filter)\b/i;

export function classify(obs: Observation): Archetype[] {
  const out = new Set<Archetype>();
  const text = obs.bodyText.toLowerCase();
  const url = obs.url.toLowerCase();

  if (obs.hasPasswordField) {
    if (/\b(sign up|register|create (an )?account)\b/.test(text) || /(signup|register)/.test(url)) out.add("signup");
    else out.add("login");
  }
  if (/(forgot|reset).{0,12}password/.test(text) || /(forgot|reset)-?password/.test(url)) out.add("forgot-password");
  if (obs.formCount > 0 && !obs.hasPasswordField) out.add("form");
  if (obs.tableCount > 0) out.add("data-table");
  if (CREATE_WORDS.test(text) && (obs.tableCount > 0 || obs.controls.some((c) => c.role === "link"))) out.add("crud-list");
  if (SEARCH_WORDS.test(text) && obs.controls.some((c) => c.role === "textbox")) out.add("search");
  if (obs.dialogOpen) out.add("modal");
  if (WIZARD_WORDS.test(text) && obs.controls.filter((c) => c.role === "button").length >= 2) out.add("wizard");
  if (out.size === 0) out.add("content");
  return [...out];
}

/** Human-readable playbook summary per archetype — surfaced to the model-in-loop layer for judgment. */
export const PLAYBOOKS: Record<Archetype, string[]> = {
  login: [
    "Password field is type=password (masked), not text.",
    "Both a 'forgot password' and a way to register are reachable.",
    "Empty submit is rejected with a clear message; wrong credentials show a non-leaky error.",
    "Form posts over HTTPS; no credentials in the URL.",
  ],
  signup: [
    "Password + confirm match rule enforced; weak-password rule if claimed.",
    "Duplicate email is rejected clearly.",
    "Every field has a visible label and an accessible name.",
  ],
  "forgot-password": [
    "Unknown email does not reveal whether an account exists (no enumeration).",
    "Success state tells the user to check their email; token flow is single-use.",
  ],
  form: [
    "Every input has a visible label + accessible name.",
    "Required fields validate on submit with the error NEAR the field, not only at the top.",
    "Boundary + invalid input rejected; valid input persists after reload.",
  ],
  "data-table": [
    "Header cells are <th>/scope'd; empty state is handled.",
    "Sort/paginate controls work and are keyboard reachable.",
    "Numbers are right-aligned + tabular; totals equal the sum of rows.",
  ],
  "crud-list": [
    "Create → appears in the list; edit persists; delete confirms and removes.",
    "Empty state guides the user to create the first item.",
    "Row actions are reachable and labelled.",
  ],
  search: ["Empty query handled; no-results state is clear; results match the query; debounced, not janky."],
  modal: ["Focus is trapped; Escape closes; focus returns to the trigger; background is inert."],
  wizard: ["Back preserves entered data; refresh mid-flow does not lose state; each step validates before Next."],
  content: ["Renders without console errors; links resolve; layout holds at every viewport."],
};
