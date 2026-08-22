#!/usr/bin/env node
/**
 * Smart launcher for @playwright/mcp — same auto-detection as the engine's `browser.mode: "auto"`.
 *
 * On a SERVER running Neko (or with $QA_NEKO_CDP pointing at a remote one), attach Playwright-MCP to
 * that Neko over CDP so every browser action is visible/watchable. On a LOCAL machine with no Neko,
 * let Playwright-MCP launch its own Chromium — headed when a display exists (you watch the real
 * window), headless otherwise. $QA_BROWSER=launch forces the local path even when Neko is reachable.
 */
import { spawn } from "node:child_process";

const LOCAL_NEKO = "http://127.0.0.1:9223";

async function reachable(endpoint, timeoutMs) {
  try {
    const base = endpoint.replace(/^ws(s?):/, "http$1:").replace(/\/+$/, "");
    const res = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

function hasDisplay() {
  if (process.platform === "darwin" || process.platform === "win32") return true;
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

const args = ["-y", "@playwright/mcp@latest"];
const forced = (process.env.QA_BROWSER ?? "").toLowerCase();
const candidate = process.env.QA_NEKO_CDP || LOCAL_NEKO;

if (forced !== "launch" && (await reachable(candidate, process.env.QA_NEKO_CDP ? 4000 : 1500))) {
  args.push("--cdp-endpoint", candidate);
  console.error(`[qa-crawler] playwright-mcp → Neko over CDP at ${candidate}`);
} else if (hasDisplay()) {
  console.error("[qa-crawler] playwright-mcp → local headed Chromium (display present, no Neko needed)");
} else {
  args.push("--headless");
  console.error("[qa-crawler] playwright-mcp → local headless Chromium (no display, no reachable Neko)");
}

const child = spawn("npx", args, { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
