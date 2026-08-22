import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { Actor, Auth, RunConfig, BrowserOpts } from "./config.js";
import { resolveSecret } from "./config.js";
import { shortHash } from "./state.js";
import { resolveCdpEndpoint, resolveHeaders } from "./neko.js";

const require = createRequire(import.meta.url);
/** axe-core ships a browser bundle; we inject its source and run it in-page. */
const AXE_SOURCE = readFileSync(require.resolve("axe-core"), "utf8");

export interface ControlSnapshot {
  role: string;
  name: string;
  selector: string;
  href: string | null;
}

export interface Observation {
  url: string;
  title: string;
  httpStatus: number | null;
  controls: ControlSnapshot[];
  links: string[]; // same-origin candidate hrefs
  consoleErrors: string[];
  networkFailures: string[];
  bodyText: string; // trimmed, for archetype hints
  hasPasswordField: boolean;
  formCount: number;
  tableCount: number;
  dialogOpen: boolean;
  overflow: boolean;
  screenshotPath: string | null;
}

/** A live, authenticated browsing session for ONE actor. Owns a Playwright context so its session persists. */
export class ActorSession {
  private consoleErrors: string[] = [];
  private networkFailures: string[] = [];
  private lastStatus: number | null = null;

  private constructor(
    readonly actor: Actor,
    readonly context: BrowserContext,
    readonly page: Page,
    /** false when we borrowed Neko's existing visible context — we must not close it. */
    private readonly ownsContext: boolean,
    private readonly bringToFront: boolean,
  ) {}

  static async create(
    context: BrowserContext,
    page: Page,
    actor: Actor,
    target: string,
    opts: { ownsContext: boolean; bringToFront: boolean },
  ): Promise<ActorSession> {
    const session = new ActorSession(actor, context, page, opts.ownsContext, opts.bringToFront);
    page.on("console", (m) => {
      if (m.type() === "error") session.consoleErrors.push(m.text().slice(0, 400));
    });
    page.on("requestfailed", (r) => {
      session.networkFailures.push(`${r.method()} ${r.url().slice(0, 200)} — ${r.failure()?.errorText ?? "failed"}`);
    });
    page.on("response", (r) => {
      if (r.url() === page.url()) session.lastStatus = r.status();
    });
    if (actor.kind === "authenticated" && actor.auth && !actor.auth.storageStatePath) {
      await session.login(actor.auth, target);
    }
    return session;
  }

  /** Run the scripted login once. Non-destructive by contract (INV-6): we never bypass the control. */
  private async login(auth: Auth, target: string): Promise<void> {
    if (auth.loginUrl) await this.page.goto(auth.loginUrl, { waitUntil: "domcontentloaded" });
    else await this.page.goto(target, { waitUntil: "domcontentloaded" });
    for (const step of auth.steps) {
      const locator = this.resolve(step.target);
      if (step.action === "goto") await this.page.goto(resolveSecret(step.value) ?? target, { waitUntil: "domcontentloaded" });
      else if (step.action === "fill") await locator.fill(resolveSecret(step.value) ?? "");
      else if (step.action === "click") await locator.click();
      else if (step.action === "press") await locator.press(resolveSecret(step.value) ?? "Enter");
      await this.page.waitForTimeout(300);
    }
    await this.page.waitForLoadState("networkidle").catch(() => {});
    const ok =
      (auth.successUrlIncludes && this.page.url().includes(auth.successUrlIncludes)) ||
      (auth.successTextIncludes && (await this.page.getByText(auth.successTextIncludes).count()) > 0) ||
      (!auth.successUrlIncludes && !auth.successTextIncludes);
    if (!ok) throw new Error(`login for actor "${this.actor.id}" did not reach its success signal (url=${this.page.url()})`);
  }

  /** Resolve a `role:name` shorthand or a raw CSS selector to a Playwright locator. */
  private resolve(target: string) {
    const m = /^([a-z]+):(.+)$/i.exec(target);
    if (m && ["button", "link", "textbox", "checkbox", "tab", "combobox", "heading"].includes(m[1]!.toLowerCase())) {
      return this.page.getByRole(m[1]!.toLowerCase() as never, { name: m[2]! });
    }
    return this.page.locator(target);
  }

  async goto(url: string): Promise<number | null> {
    this.consoleErrors = [];
    this.networkFailures = [];
    this.lastStatus = null;
    if (this.bringToFront) await this.page.bringToFront().catch(() => {});
    const resp = await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null);
    await this.page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    return resp?.status() ?? this.lastStatus;
  }

  /** Everything the engine and the model need to judge the current screen. */
  async observe(opts: { screenshot?: boolean; evidenceDir?: string; screenshotName?: string } = {}): Promise<Observation> {
    const page = this.page;
    const data = await page.evaluate(() => {
      const roleOf = (el: Element): string => {
        const r = el.getAttribute("role");
        if (r) return r;
        const tag = el.tagName.toLowerCase();
        if (tag === "a") return "link";
        if (tag === "button") return "button";
        if (tag === "select") return "combobox";
        if (tag === "textarea") return "textbox";
        if (tag === "input") {
          const t = (el as HTMLInputElement).type;
          if (["button", "submit", "reset"].includes(t)) return "button";
          if (t === "checkbox") return "checkbox";
          if (t === "radio") return "radio";
          return "textbox";
        }
        return tag;
      };
      const nameOf = (el: Element): string => {
        const al = el.getAttribute("aria-label");
        if (al) return al.trim();
        const labelledby = el.getAttribute("aria-labelledby");
        if (labelledby) {
          const t = labelledby.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim();
          if (t) return t;
        }
        const ph = el.getAttribute("placeholder");
        if (ph) return ph.trim();
        const txt = (el.textContent ?? "").trim().replace(/\s+/g, " ");
        return txt.slice(0, 80);
      };
      const cssPath = (el: Element): string => {
        if (el.id) return `#${CSS.escape(el.id)}`;
        const parts: string[] = [];
        let node: Element | null = el;
        while (node && node.nodeType === 1 && parts.length < 5) {
          let sel = node.tagName.toLowerCase();
          const parent = node.parentElement;
          if (parent) {
            const sibs = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
            if (sibs.length > 1) sel += `:nth-of-type(${sibs.indexOf(node) + 1})`;
          }
          parts.unshift(sel);
          node = node.parentElement;
        }
        return parts.join(" > ");
      };
      const sel = "a[href],button,input,select,textarea,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=switch],[contenteditable=true]";
      const els = Array.from(document.querySelectorAll(sel)).filter((el) => {
        const s = getComputedStyle(el as Element);
        const r = (el as HTMLElement).getBoundingClientRect();
        return s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0;
      });
      const controls = els.slice(0, 400).map((el) => ({
        role: roleOf(el),
        name: nameOf(el),
        selector: cssPath(el),
        href: (el as HTMLAnchorElement).href || null,
      }));
      const links = Array.from(document.querySelectorAll("a[href]"))
        .map((a) => (a as HTMLAnchorElement).href)
        .filter((h) => h && !h.startsWith("javascript:") && !h.startsWith("mailto:") && !h.startsWith("tel:"));
      const de = document.documentElement;
      return {
        title: document.title,
        controls,
        links: Array.from(new Set(links)),
        bodyText: (document.body?.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 2000),
        hasPasswordField: !!document.querySelector('input[type="password"]'),
        formCount: document.querySelectorAll("form").length,
        tableCount: document.querySelectorAll("table, [role=table], [role=grid]").length,
        dialogOpen: !!document.querySelector('[role=dialog]:not([aria-hidden=true]), dialog[open]'),
        overflow: de.scrollWidth > de.clientWidth + 2,
      };
    });

    let screenshotPath: string | null = null;
    if (opts.screenshot && opts.evidenceDir) {
      const name = `${opts.screenshotName ?? shortHash(page.url())}.png`;
      screenshotPath = join(opts.evidenceDir, name);
      await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => (screenshotPath = null));
    }

    return {
      url: page.url(),
      title: data.title,
      httpStatus: this.lastStatus,
      controls: data.controls,
      links: data.links,
      consoleErrors: [...this.consoleErrors],
      networkFailures: [...this.networkFailures],
      bodyText: data.bodyText,
      hasPasswordField: data.hasPasswordField,
      formCount: data.formCount,
      tableCount: data.tableCount,
      dialogOpen: data.dialogOpen,
      overflow: data.overflow,
      screenshotPath,
    };
  }

  /** axe-core accessibility scan of the current page. Returns violations with impact + node targets. */
  async runAxe(): Promise<{ id: string; impact: string; help: string; nodes: number; sample: string }[]> {
    await this.page.addScriptTag({ content: AXE_SOURCE }).catch(() => {});
    const results = await this.page
      .evaluate(async () => {
        const axe = (window as unknown as { axe?: { run: (o: unknown) => Promise<unknown> } }).axe;
        if (!axe) return [];
        const r = (await axe.run({ resultTypes: ["violations"] })) as {
          violations: { id: string; impact: string | null; help: string; nodes: { target: string[] }[] }[];
        };
        return r.violations.map((v) => ({
          id: v.id,
          impact: v.impact ?? "minor",
          help: v.help,
          nodes: v.nodes.length,
          sample: v.nodes[0]?.target?.join(" ") ?? "",
        }));
      })
      .catch(() => [] as never);
    return results as { id: string; impact: string; help: string; nodes: number; sample: string }[];
  }

  /** Model-in-loop interaction verb (used by the qa_act MCP tool). Small, safe, observable set. */
  async act(action: { kind: "click" | "fill" | "select" | "press"; target: string; value?: string }): Promise<void> {
    if (this.bringToFront) await this.page.bringToFront().catch(() => {});
    const loc = this.resolve(action.target);
    if (action.kind === "click") await loc.click({ timeout: 8000 });
    else if (action.kind === "fill") await loc.fill(action.value ?? "");
    else if (action.kind === "select") await loc.selectOption(action.value ?? "");
    else if (action.kind === "press") await loc.press(action.value ?? "Enter");
    await this.page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
  }

  async setViewport(w: number, h: number): Promise<void> {
    await this.page.setViewportSize({ width: w, height: h });
  }

  /** Close only what we created — a borrowed Neko visible context is left exactly as it was. */
  async close(): Promise<void> {
    if (this.ownsContext) await this.context.close().catch(() => {});
  }
}

/**
 * Owns the browser and hands out one ActorSession per actor.
 *
 * `launch` mode starts a headless Chromium we own. `neko`/`cdp` mode CONNECTS to a browser we do NOT
 * own (the user's Neko) — so on close we disconnect, never kill it. The first actor can reuse Neko's
 * existing visible context so the run appears in the tab the user is already watching; further actors
 * get isolated contexts (still in the same visible Chrome, brought to front as they act).
 */
export class BrowserPool {
  private visibleClaimed = false;

  private constructor(
    readonly browser: Browser,
    private readonly ownsBrowser: boolean,
    private readonly opts: BrowserOpts,
  ) {}

  static async launch(config: RunConfig): Promise<BrowserPool> {
    const b = config.browser;
    if (b.mode === "launch") {
      const browser = await chromium.launch({ headless: config.headless, slowMo: b.slowMo });
      return new BrowserPool(browser, true, b);
    }
    // neko / cdp: connect over the DevTools Protocol to a browser we do not own.
    const endpointURL = resolveCdpEndpoint(b);
    const browser = await chromium.connectOverCDP(endpointURL, {
      headers: resolveHeaders(b.headers),
      slowMo: b.slowMo,
      timeout: 20000,
    });
    return new BrowserPool(browser, false, b);
  }

  async session(actor: Actor, target: string): Promise<ActorSession> {
    const storage = actor.auth?.storageStatePath;
    let context: BrowserContext;
    let page: Page;
    let ownsContext: boolean;

    const canReuse = !this.ownsBrowser && this.opts.reuseVisibleContext && !this.visibleClaimed && !storage;
    const existing = this.browser.contexts();
    if (canReuse && existing.length > 0 && existing[0]) {
      context = existing[0];
      page = context.pages()[0] ?? (await context.newPage());
      ownsContext = false;
      this.visibleClaimed = true;
    } else {
      context = await this.browser.newContext(storage ? { storageState: storage } : {});
      page = await context.newPage();
      ownsContext = true;
    }
    return ActorSession.create(context, page, actor, target, { ownsContext, bringToFront: this.opts.bringToFront });
  }

  async close(): Promise<void> {
    // Only kill a browser we launched. A CDP-connected Neko is disconnected, never closed.
    if (this.ownsBrowser) await this.browser.close().catch(() => {});
  }
}
