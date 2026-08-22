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
): Promise<{ ok: boolean; endpoint: string; browser?: string; error?: string }> {
  try {
    const res = await fetch(`${httpBase(endpoint)}/json/version`, { headers, signal: AbortSignal.timeout(6000) });
    if (!res.ok) return { ok: false, endpoint, error: `CDP responded ${res.status}` };
    const v = (await res.json()) as { Browser?: string; webSocketDebuggerUrl?: string };
    return { ok: true, endpoint, browser: v.Browser ?? "unknown" };
  } catch (e) {
    return { ok: false, endpoint, error: (e as Error).message };
  }
}
