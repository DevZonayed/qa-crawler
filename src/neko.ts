import type { BrowserOpts } from "./config.js";
import { resolveSecret } from "./config.js";

/**
 * Neko / CDP transport helpers.
 *
 * Neko is a self-hosted, streamed Chrome the user watches (and can grab the mouse of, to solve an MFA
 * prompt or CAPTCHA) at their Neko URL. The engine drives it over the Chrome DevTools Protocol. Locally
 * that endpoint is http://127.0.0.1:9223; a REMOTE Neko is added by pointing `cdpEndpoint` at that
 * host's exposed/tunnelled CDP (see the README for how to expose it safely).
 */

export const LOCAL_NEKO_CDP = "http://127.0.0.1:9223";

/** The concrete CDP endpoint for a browser config, applying the neko-mode default. */
export function resolveCdpEndpoint(browser: BrowserOpts): string {
  const raw = resolveSecret(browser.cdpEndpoint) ?? (browser.mode === "neko" ? LOCAL_NEKO_CDP : "");
  if (!raw) throw new Error(`browser.mode="${browser.mode}" needs a cdpEndpoint (e.g. http://127.0.0.1:9223 for a local Neko).`);
  return raw;
}

/** Resolve `${ENV}` in header values so a remote token never sits in the config file. */
export function resolveHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k] = resolveSecret(v) ?? v;
  return out;
}

/** The http(s) base for a CDP endpoint, whether it was given as ws(s):// or http(s)://. */
function httpBase(endpoint: string): string {
  return endpoint.replace(/^ws:/, "http:").replace(/^wss:/, "https:").replace(/\/+$/, "");
}

/**
 * Verify a CDP endpoint is reachable before a run, and report which browser is on the other end.
 * `/json/version` is the CDP discovery endpoint every Chrome exposes.
 */
export async function checkCdp(
  endpoint: string,
  headers: Record<string, string> = {},
  timeoutMs = 6000,
): Promise<{ ok: boolean; endpoint: string; browser?: string; error?: string }> {
  try {
    const res = await fetch(`${httpBase(endpoint)}/json/version`, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, endpoint, error: `CDP responded ${res.status}` };
    const v = (await res.json()) as { Browser?: string; webSocketDebuggerUrl?: string };
    return { ok: true, endpoint, browser: v.Browser ?? "unknown" };
  } catch (e) {
    return { ok: false, endpoint, error: (e as Error).message };
  }
}

/** Is there a screen a locally-launched headed Chromium could appear on? */
export function hasDisplay(): boolean {
  if (process.platform === "darwin" || process.platform === "win32") return true;
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

/** The concrete transport `auto` (or an explicit mode) resolves to. */
export type BrowserPlan =
  | { kind: "cdp"; endpoint: string; headers: Record<string, string>; via: "neko" | "cdp" | "auto" }
  | { kind: "launch"; headless: boolean; via: "launch" | "auto" };

/**
 * Resolve the browser transport for a run.
 *
 * Explicit modes are honoured as-is. `auto` picks the right thing for the machine:
 *  1. `$QA_BROWSER` (launch|neko|cdp) forces a mode without touching the config file.
 *  2. A configured `cdpEndpoint` or `$QA_NEKO_CDP` that answers → use it (a server with Neko,
 *     or a tunnelled remote Neko).
 *  3. The local Neko default (127.0.0.1:9223) answering → use it (this box runs Neko).
 *  4. Otherwise LAUNCH Playwright's own Chromium — HEADED when a display exists (a laptop:
 *     the user watches the real window, no Neko needed), headless when there is none (CI).
 */
export async function resolveBrowserPlan(
  browser: BrowserOpts,
  configHeadless: boolean,
): Promise<BrowserPlan> {
  const forced = (process.env.QA_BROWSER ?? "").toLowerCase();
  const mode = forced === "launch" || forced === "neko" || forced === "cdp" ? forced : browser.mode;

  if (mode === "launch") return { kind: "launch", headless: configHeadless, via: "launch" };
  if (mode === "neko" || mode === "cdp") {
    return { kind: "cdp", endpoint: resolveCdpEndpoint({ ...browser, mode }), headers: resolveHeaders(browser.headers), via: mode };
  }

  // auto —
  const headers = resolveHeaders(browser.headers);
  const explicit = resolveSecret(browser.cdpEndpoint) ?? process.env.QA_NEKO_CDP;
  if (explicit) {
    const probe = await checkCdp(explicit, headers, 4000);
    if (probe.ok) return { kind: "cdp", endpoint: explicit, headers, via: "auto" };
  }
  const local = await checkCdp(LOCAL_NEKO_CDP, {}, 1500);
  if (local.ok) return { kind: "cdp", endpoint: LOCAL_NEKO_CDP, headers: {}, via: "auto" };
  return { kind: "launch", headless: hasDisplay() ? false : true, via: "auto" };
}
