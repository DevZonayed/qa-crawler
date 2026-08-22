import { z } from "zod";

/**
 * A run's configuration. Everything the engine needs is declarative so a run is reproducible and
 * resumable: two runs with the same config against the same build produce the same node ids.
 */

/** One scripted step of a login (or any reach-the-anchor) sequence. Non-destructive by contract. */
export const AuthStepSchema = z.object({
  /** CSS selector, or `role:name` (e.g. `textbox:Email`) resolved via the accessibility tree. */
  target: z.string(),
  action: z.enum(["fill", "click", "press", "goto"]),
  /** Value for fill/press (the key for press), or the URL for goto. Secrets may be `${ENV_VAR}`. */
  value: z.string().optional(),
});
export type AuthStep = z.infer<typeof AuthStepSchema>;

export const AuthSchema = z.object({
  loginUrl: z.string().url().optional(),
  steps: z.array(AuthStepSchema).default([]),
  /** After the steps, the run is "logged in" once this URL substring or text is seen. */
  successUrlIncludes: z.string().optional(),
  successTextIncludes: z.string().optional(),
  /** Alternatively, reuse a Playwright storageState JSON (skip the scripted login entirely). */
  storageStatePath: z.string().optional(),
});
export type Auth = z.infer<typeof AuthSchema>;

/**
 * An actor is a distinct identity/permission the app is crawled AS. `anonymous` starts from the login
 * page (so it naturally explores register / forgot-password); an authenticated actor logs in first.
 * Crawling per-actor is how permission and empty-state bugs — the cells a happy path never enters —
 * get covered.
 */
export const ActorSchema = z.object({
  id: z.string(),
  kind: z.enum(["anonymous", "authenticated"]).default("authenticated"),
  auth: AuthSchema.optional(),
});
export type Actor = z.infer<typeof ActorSchema>;

export const ScopeSchema = z.object({
  /** Only crawl URLs whose path matches one of these globs (default: everything under the origin). */
  include: z.array(z.string()).default(["**"]),
  /** Never visit these (logout, external, destructive admin, etc.). */
  exclude: z.array(z.string()).default(["**/logout", "**/signout", "**/sign-out"]),
  maxDepth: z.number().int().positive().default(6),
  maxNodes: z.number().int().positive().default(500),
  /** Stay on this origin. Off-origin links are recorded but not entered. */
  sameOriginOnly: z.boolean().default(true),
});
export type Scope = z.infer<typeof ScopeSchema>;

/** Path-pattern → risk tier. First match wins; unmatched defaults to T2. Drives depth (see the Standard). */
export const TierRuleSchema = z.object({ pattern: z.string(), tier: z.enum(["T1", "T2", "T3"]) });

export const ChecksSchema = z.object({
  http: z.boolean().default(true),
  console: z.boolean().default(true),
  brokenLinks: z.boolean().default(true),
  overflow: z.boolean().default(true),
  axe: z.boolean().default(true),
  /** Actually interact with forms (submit empties, bad input). OFF by default — INV-6, do no harm. */
  formProbing: z.boolean().default(false),
  screenshot: z.boolean().default(true),
});
export type Checks = z.infer<typeof ChecksSchema>;

export const ViewportSchema = z.object({ label: z.string(), w: z.number().int(), h: z.number().int() });

/**
 * Where the browser comes from.
 *
 * - `launch` (default): the engine starts its own headless Chromium. Fast, isolated, invisible.
 * - `neko`:  connect over CDP to a Neko browser — a real, visible Chrome the user watches and can
 *            take over mid-run (to solve an MFA prompt or CAPTCHA), then hand back. Local default
 *            endpoint is `http://127.0.0.1:9223`.
 * - `cdp`:   connect over CDP to ANY endpoint — this is how a REMOTE Neko is added: point
 *            `cdpEndpoint` at the remote host's exposed/tunnelled CDP (ws(s):// or http(s)://), with
 *            optional `headers` for auth.
 *
 * A CDP connection is NEVER killed on close (that would kill the user's Neko) — we only close the
 * contexts we created.
 */
export const BrowserSchema = z.object({
  mode: z.enum(["launch", "neko", "cdp"]).default("launch"),
  /** CDP endpoint for neko/cdp. Defaults to http://127.0.0.1:9223 in `neko` mode. `${ENV}` allowed. */
  cdpEndpoint: z.string().optional(),
  /** Headers sent when connecting (e.g. `{ "Authorization": "Bearer ${NEKO_TOKEN}" }`) for a remote Neko behind auth. */
  headers: z.record(z.string()).default({}),
  /** Use Neko's EXISTING visible context/tab for the first actor (so it appears in the tab the user is watching). */
  reuseVisibleContext: z.boolean().default(true),
  /** Bring the acted page to the front before each step, so the shared Neko screen shows the active tab. */
  bringToFront: z.boolean().default(true),
  /** Slow each action down (ms) so a human watching Neko can follow along. 0 = full speed. */
  slowMo: z.number().int().nonnegative().default(0),
});
export type BrowserOpts = z.infer<typeof BrowserSchema>;

export const RunConfigSchema = z.object({
  name: z.string().default("qa-run"),
  target: z.string().url(),
  /** Extra start URLs beyond `target` (and each actor's login page). */
  seeds: z.array(z.string()).default([]),
  actors: z.array(ActorSchema).default([{ id: "anonymous", kind: "anonymous" }]),
  scope: ScopeSchema.default({}),
  tiers: z.array(TierRuleSchema).default([]),
  checks: ChecksSchema.default({}),
  viewports: z
    .array(ViewportSchema)
    .default([
      { label: "mobile", w: 375, h: 812 },
      { label: "desktop", w: 1440, h: 900 },
    ]),
  /** Where the ledger, evidence and reports for this run are written. */
  outDir: z.string().default("runs"),
  /** Browser transport: local launch, or connect over CDP to a (local or remote) Neko. */
  browser: BrowserSchema.default({}),
  /** Only used in `launch` mode. Neko is always headful (that is the point — you watch it). */
  headless: z.boolean().default(true),
  /** Politeness: ms to wait between navigations. */
  throttleMs: z.number().int().nonnegative().default(150),
});
export type RunConfig = z.infer<typeof RunConfigSchema>;

/** Resolve `${ENV}` placeholders in a value against process.env (so secrets never sit in the config file). */
export function resolveSecret(value: string | undefined): string | undefined {
  if (!value) return value;
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, k) => process.env[k] ?? "");
}
