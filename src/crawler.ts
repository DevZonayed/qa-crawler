import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunConfig, Actor } from "./config.js";
import { RunConfigSchema } from "./config.js";
import { BrowserPool, ActorSession, type Observation } from "./browser.js";
import { Ledger, type NodeRow, type Tier } from "./ledger.js";
import { classify, PLAYBOOKS, type Archetype } from "./archetypes.js";
import { runChecks, findingId, resetLinkBudget, type RawFinding } from "./checks.js";
import { nodeId, routeTemplate, sameOrigin, matchesAny, shortHash } from "./state.js";

/**
 * A live run. Owns the browser, one session per actor, and the ledger. Everything the run KNOWS lives
 * in the ledger (INV-4), so this object can be thrown away and rebuilt from disk to resume.
 *
 * Graph expansion follows same-origin LINKS (safe, deterministic) and inventories EVERY control for
 * coverage. Exercising non-link controls (buttons/actions), which can be destructive, is the
 * model-in-loop layer's job (qa_replay_to → qa_act → qa_observe) under the do-no-harm gate.
 */
export class Run {
  readonly id: string;
  readonly config: RunConfig;
  readonly ledger: Ledger;
  private pool!: BrowserPool;
  private sessions = new Map<string, ActorSession>();

  private constructor(id: string, config: RunConfig, ledger: Ledger) {
    this.id = id;
    this.config = config;
    this.ledger = ledger;
  }

  /**
   * Start a new run, or RESUME one: pass `existingId` (a prior runId) and the same `outDir`, and this
   * reopens `outDir/<runId>/ledger.db`, re-queues any node interrupted mid-inspection, and continues
   * from the frontier. Everything already `passed`/`failed` stays done — inspection is idempotent and
   * `enqueue` skips known nodes, so resuming never redoes finished work.
   */
  static async create(rawConfig: unknown, existingId?: string): Promise<Run> {
    const config = RunConfigSchema.parse(rawConfig);
    const id = existingId ?? `${config.name}-${new Date().toISOString().slice(0, 10)}-${shortHash(randomUUID()).slice(0, 6)}`;
    const ledger = new Ledger(config.outDir, id);
    ledger.startRun(id, config.name, config.target, JSON.stringify(config));
    const requeued = existingId ? ledger.requeueInterrupted(id) : 0;
    resetLinkBudget(); // the MCP server is long-lived; each run gets a fresh link-check budget
    const run = new Run(id, config, ledger);
    run.resumedInterrupted = requeued;
    await run.boot();
    return run;
  }

  /** How many `in_progress` nodes were put back on the frontier when this run was resumed. */
  resumedInterrupted = 0;

  /** Which browser transport `auto` (or an explicit mode) actually resolved to. */
  get browserDescription(): string {
    return this.pool?.description ?? "(not booted)";
  }

  private async boot(): Promise<void> {
    this.pool = await BrowserPool.launch(this.config);
    for (const actor of this.config.actors) {
      const session = await this.pool.session(actor, this.config.target);
      this.sessions.set(actor.id, session);
      this.seed(actor, session);
    }
  }

  /** Seed the frontier for one actor: the target, any configured seeds, and (anonymous) the login page. */
  private seed(actor: Actor, session: ActorSession): void {
    const urls = new Set<string>([this.config.target, ...this.config.seeds]);
    if (actor.kind === "anonymous" && actor.auth?.loginUrl) urls.add(actor.auth.loginUrl);
    // For an authenticated actor, the current URL after login is a real anchor too.
    if (actor.kind === "authenticated") urls.add(session.page.url());
    for (const url of urls) this.enqueueUrl(actor.id, url, 0, null);
  }

  private tierOf(url: string): Tier {
    const path = new URL(url, this.config.target).pathname;
    for (const rule of this.config.tiers) if (matchesAny(path, [rule.pattern])) return rule.tier;
    return "T2";
  }

  private inScope(url: string): boolean {
    let path: string;
    try {
      path = new URL(url, this.config.target).pathname;
    } catch {
      return false;
    }
    if (this.config.scope.sameOriginOnly && !sameOrigin(url, this.config.target)) return false;
    if (matchesAny(path, this.config.scope.exclude)) return false;
    return matchesAny(path, this.config.scope.include);
  }

  private enqueueUrl(actorId: string, url: string, depth: number, parentId: string | null): void {
    if (depth > this.config.scope.maxDepth) return;
    if (!this.inScope(url)) return;
    const status = this.ledger.status(this.id);
    if (status.total >= this.config.scope.maxNodes) return;
    const id = nodeId(actorId, url, this.config.target);
    this.ledger.enqueue({
      id,
      run_id: this.id,
      actor: actorId,
      url,
      route_template: routeTemplate(url, this.config.target),
      depth,
      tier: this.tierOf(url),
      archetypes: "[]",
      parent_id: parentId,
      replay_path: JSON.stringify([{ action: "goto", value: url }]),
    });
  }

  private session(actorId: string): ActorSession {
    const s = this.sessions.get(actorId);
    if (!s) throw new Error(`no live session for actor ${actorId}`);
    return s;
  }

  /** Navigate the actor's browser to a node via its recorded replay path from the anchor. */
  async replayTo(node: NodeRow): Promise<Observation> {
    const session = this.session(node.actor);
    const steps = JSON.parse(node.replay_path) as { action: string; value?: string }[];
    for (const step of steps) {
      if (step.action === "goto" && step.value) await session.goto(step.value);
      else if (step.value) await session.act({ kind: step.action as never, target: step.value });
    }
    return session.observe({ screenshot: false });
  }

  /**
   * Inspect one node: replay to it, observe across viewports, classify, run the deterministic checks,
   * inventory controls, enqueue newly-discovered links, and record the verdict + evidence.
   * This is the atomic, resumable unit of work.
   */
  async inspect(node: NodeRow): Promise<{ archetypes: Archetype[]; findings: RawFinding[]; observation: Observation }> {
    const session = this.session(node.actor);
    this.ledger.setStatus(node.id, "in_progress");
    if (this.config.throttleMs) await new Promise((r) => setTimeout(r, this.config.throttleMs));

    const httpStatus = await session.goto(node.url);
    const evidence: Record<string, unknown> = { http: httpStatus };

    // Primary viewport: full observation + checks.
    const primary = this.config.viewports[this.config.viewports.length - 1] ?? { label: "desktop", w: 1440, h: 900 };
    await session.setViewport(primary.w, primary.h);
    const obs = await session.observe({
      screenshot: this.config.checks.screenshot,
      evidenceDir: this.ledger.evidenceDir,
      screenshotName: `${shortHash(node.id)}-${primary.label}`,
    });
    obs.httpStatus = httpStatus;
    if (obs.screenshotPath) evidence[`screenshot_${primary.label}`] = obs.screenshotPath;

    const archetypes = classify(obs);
    const findings: RawFinding[] = await runChecks(session, obs, archetypes, this.config);

    // Responsive sweep: other viewports get an overflow + screenshot check.
    for (const vp of this.config.viewports) {
      if (vp.label === primary.label) continue;
      await session.setViewport(vp.w, vp.h);
      const vobs = await session.observe({
        screenshot: this.config.checks.screenshot,
        evidenceDir: this.ledger.evidenceDir,
        screenshotName: `${shortHash(node.id)}-${vp.label}`,
      });
      if (vobs.screenshotPath) evidence[`screenshot_${vp.label}`] = vobs.screenshotPath;
      if (this.config.checks.overflow && vobs.overflow) {
        // Reproduce-before-report: only a symptom that survives a second measurement is a finding.
        const confirmed = await session.confirmOverflow();
        if (confirmed.overflow)
          findings.push({
            severity: "S4",
            category: "visual",
            title: `Horizontal overflow at ${vp.label} (${vp.w}px)`,
            detail: `The page scrolls sideways at ${vp.w}×${vp.h} by ${confirmed.px}px — confirmed by a second measurement after layout settled. Wide content should scroll inside its own overflow-x container instead of the page body.`,
            expected: "documentElement.scrollWidth <= clientWidth",
            actual: `${confirmed.px}px of horizontal overflow`,
          });
      }
    }
    await session.setViewport(primary.w, primary.h);

    // Inventory every control (INV-2) — the anti-skip ledger of this screen.
    this.ledger.addControls(
      this.id,
      node.id,
      obs.controls.map((c) => ({
        id: "C-" + shortHash(node.id, c.selector, c.name),
        role: c.role,
        name: c.name,
        selector: c.selector,
        href: c.href,
      })),
    );

    // Expand the graph along same-origin links.
    for (const href of obs.links) this.enqueueUrl(node.actor, href, node.depth + 1, node.id);

    // Persist findings.
    for (const f of findings)
      this.ledger.addFinding({
        id: findingId(this.id, node.id, f),
        run_id: this.id,
        node_id: node.id,
        severity: f.severity,
        category: f.category,
        title: f.title,
        detail: f.detail,
        expected: f.expected ?? null,
        actual: f.actual ?? null,
        repro: JSON.stringify([`As "${node.actor}", open ${node.url}`]),
        evidence: JSON.stringify(f.evidence ?? evidence),
      });

    const blocking = findings.some((f) => f.severity === "S1" || f.severity === "S2");
    this.ledger.setStatus(node.id, blocking ? "failed" : "passed", {
      archetypes: JSON.stringify(archetypes),
      controls_count: obs.controls.length,
      http_status: httpStatus,
      evidence: JSON.stringify(evidence),
      notes: `archetypes: ${archetypes.join(", ")}`,
    });

    return { archetypes, findings, observation: obs };
  }

  /** Deterministic full crawl. Runs until the frontier is empty or maxNodes is hit. Fully resumable. */
  async crawlAuto(onProgress?: (n: NodeRow, i: number) => void): Promise<void> {
    let i = 0;
    for (;;) {
      const node = this.ledger.nextQueued(this.id);
      if (!node) break;
      if (i >= this.config.scope.maxNodes) {
        this.ledger.setStatus(node.id, "skipped", { notes: "maxNodes budget reached (INV-5: surfaced, not hidden)" });
        continue;
      }
      try {
        await this.inspect(node);
      } catch (err) {
        this.ledger.setStatus(node.id, "blocked", { notes: `error: ${(err as Error).message}` });
      }
      onProgress?.(node, ++i);
    }
  }

  /** Model-in-loop: hand out the next frontier node with everything needed to judge it. */
  async crawlNext(): Promise<{
    node: NodeRow;
    observation: Observation;
    archetypes: Archetype[];
    playbook: string[];
    engineFindings: RawFinding[];
  } | null> {
    const node = this.ledger.nextQueued(this.id);
    if (!node) return null;
    const { archetypes, findings, observation } = await this.inspect(node);
    // inspect() already set a verdict; the model may override via qa_record_verdict after judging.
    const playbook = archetypes.flatMap((a) => PLAYBOOKS[a] ?? []);
    return { node, observation, archetypes, playbook, engineFindings: findings };
  }

  writeSitemap(): string {
    const nodes = this.ledger.allNodes(this.id);
    const path = join(this.ledger.runDir, "sitemap.json");
    writeFileSync(
      path,
      JSON.stringify(
        nodes.map((n) => ({ actor: n.actor, route: n.route_template, tier: n.tier, status: n.status, archetypes: JSON.parse(n.archetypes) })),
        null,
        2,
      ),
    );
    return path;
  }

  async close(): Promise<void> {
    for (const s of this.sessions.values()) await s.close();
    await this.pool?.close();
    this.ledger.finishRun(this.id);
  }
}
