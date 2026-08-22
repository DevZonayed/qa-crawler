import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The coverage ledger — the run's single source of truth, in SQLite.
 *
 * INV-2 (coverage is enumerated) and INV-4 (context is volatile, state is durable) both live here.
 * Every crawled surface is a row with a verdict; completeness is a query, not a feeling; and after any
 * crash or context reset the run resumes by reading this file, never from memory. The frontier is
 * literally `SELECT ... WHERE status='queued'`.
 */

export type NodeStatus = "queued" | "in_progress" | "passed" | "failed" | "blocked" | "skipped";
export type Tier = "T1" | "T2" | "T3";
export type Severity = "S1" | "S2" | "S3" | "S4" | "S5";

export interface NodeRow {
  id: string;
  run_id: string;
  actor: string;
  url: string;
  route_template: string;
  depth: number;
  tier: Tier;
  status: NodeStatus;
  archetypes: string; // JSON array
  controls_count: number;
  parent_id: string | null;
  replay_path: string; // JSON: how to reach this node from its actor's anchor
  http_status: number | null;
  evidence: string; // JSON: { screenshot, dom, ... } pointers
  notes: string | null;
  updated_at: string;
}

export interface FindingRow {
  id: string;
  run_id: string;
  node_id: string | null;
  severity: Severity;
  category: string;
  title: string;
  detail: string;
  expected: string | null;
  actual: string | null;
  repro: string; // JSON array of steps
  evidence: string; // JSON pointers
  status: "open" | "fixed" | "wont_fix" | "confirmed" | "intermittent";
  created_at: string;
}

export class Ledger {
  readonly db: Database.Database;
  readonly runDir: string;
  readonly evidenceDir: string;

  constructor(outDir: string, runId: string) {
    this.runDir = join(outDir, runId);
    this.evidenceDir = join(this.runDir, "evidence");
    mkdirSync(this.evidenceDir, { recursive: true });
    this.db = new Database(join(this.runDir, "ledger.db"));
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, name TEXT, target TEXT, config TEXT,
        started_at TEXT, finished_at TEXT
      );
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY, run_id TEXT, actor TEXT, url TEXT, route_template TEXT,
        depth INTEGER, tier TEXT, status TEXT, archetypes TEXT DEFAULT '[]',
        controls_count INTEGER DEFAULT 0, parent_id TEXT, replay_path TEXT DEFAULT '[]',
        http_status INTEGER, evidence TEXT DEFAULT '{}', notes TEXT, updated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS controls (
        id TEXT PRIMARY KEY, run_id TEXT, node_id TEXT, role TEXT, name TEXT,
        selector TEXT, href TEXT, exercised INTEGER DEFAULT 0, verdict TEXT
      );
      CREATE TABLE IF NOT EXISTS findings (
        id TEXT PRIMARY KEY, run_id TEXT, node_id TEXT, severity TEXT, category TEXT,
        title TEXT, detail TEXT, expected TEXT, actual TEXT, repro TEXT DEFAULT '[]',
        evidence TEXT DEFAULT '{}', status TEXT DEFAULT 'open', created_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_nodes_status ON nodes(run_id, status);
      CREATE INDEX IF NOT EXISTS idx_findings_sev ON findings(run_id, severity);
    `);
  }

  startRun(runId: string, name: string, target: string, config: string): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO runs(id,name,target,config,started_at) VALUES(?,?,?,?,?)`)
      .run(runId, name, target, config, new Date().toISOString());
  }

  finishRun(runId: string): void {
    this.db.prepare(`UPDATE runs SET finished_at=? WHERE id=?`).run(new Date().toISOString(), runId);
  }

  /** Enqueue a node if we've never seen this (actor::routeTemplate). Returns true if newly added. */
  enqueue(node: Omit<NodeRow, "status" | "updated_at" | "http_status" | "evidence" | "notes" | "controls_count">): boolean {
    const exists = this.db.prepare(`SELECT 1 FROM nodes WHERE id=?`).get(node.id);
    if (exists) return false;
    this.db
      .prepare(
        `INSERT INTO nodes(id,run_id,actor,url,route_template,depth,tier,status,archetypes,controls_count,parent_id,replay_path,http_status,evidence,notes,updated_at)
         VALUES(@id,@run_id,@actor,@url,@route_template,@depth,@tier,'queued',@archetypes,0,@parent_id,@replay_path,NULL,'{}',NULL,@updated_at)`,
      )
      .run({ ...node, updated_at: new Date().toISOString() });
    return true;
  }

  /**
   * Resume hygiene: a node left `in_progress` was interrupted mid-inspection (crash, kill, context
   * reset). Put it back on the frontier so the resumed run picks it up — inspection is idempotent, so
   * re-running it is safe. Returns how many were re-queued.
   */
  requeueInterrupted(runId: string): number {
    const r = this.db
      .prepare(`UPDATE nodes SET status='queued', updated_at=? WHERE run_id=? AND status='in_progress'`)
      .run(new Date().toISOString(), runId);
    return r.changes;
  }

  /** The frontier: the next queued node, T1 first (risk throttles depth), then shallowest. */
  nextQueued(runId: string): NodeRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM nodes WHERE run_id=? AND status='queued'
         ORDER BY CASE tier WHEN 'T1' THEN 0 WHEN 'T2' THEN 1 ELSE 2 END, depth ASC LIMIT 1`,
      )
      .get(runId) as NodeRow | undefined;
  }

  setStatus(id: string, status: NodeStatus, patch: Partial<NodeRow> = {}): void {
    const cur = this.db.prepare(`SELECT * FROM nodes WHERE id=?`).get(id) as NodeRow | undefined;
    if (!cur) return;
    const merged = { ...cur, ...patch, status, updated_at: new Date().toISOString() };
    this.db
      .prepare(
        `UPDATE nodes SET status=@status, archetypes=@archetypes, controls_count=@controls_count,
         http_status=@http_status, evidence=@evidence, notes=@notes, updated_at=@updated_at WHERE id=@id`,
      )
      .run(merged);
  }

  addControls(runId: string, nodeId: string, controls: { id: string; role: string; name: string; selector: string; href: string | null }[]): void {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO controls(id,run_id,node_id,role,name,selector,href) VALUES(?,?,?,?,?,?,?)`,
    );
    const tx = this.db.transaction(() => {
      for (const c of controls) stmt.run(c.id, runId, nodeId, c.role, c.name, c.selector, c.href);
    });
    tx();
  }

  addFinding(f: Omit<FindingRow, "created_at" | "status"> & { status?: FindingRow["status"] }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO findings(id,run_id,node_id,severity,category,title,detail,expected,actual,repro,evidence,status,created_at)
         VALUES(@id,@run_id,@node_id,@severity,@category,@title,@detail,@expected,@actual,@repro,@evidence,@status,@created_at)`,
      )
      .run({ ...f, status: f.status ?? "open", created_at: new Date().toISOString() });
  }

  status(runId: string): {
    total: number;
    byStatus: Record<string, number>;
    findingsBySeverity: Record<string, number>;
    notTested: { id: string; url: string; status: string }[];
    coveragePct: number;
  } {
    const total = (this.db.prepare(`SELECT COUNT(*) n FROM nodes WHERE run_id=?`).get(runId) as { n: number }).n;
    const byStatus: Record<string, number> = {};
    for (const r of this.db.prepare(`SELECT status, COUNT(*) n FROM nodes WHERE run_id=? GROUP BY status`).all(runId) as { status: string; n: number }[])
      byStatus[r.status] = r.n;
    const findingsBySeverity: Record<string, number> = {};
    for (const r of this.db.prepare(`SELECT severity, COUNT(*) n FROM findings WHERE run_id=? GROUP BY severity`).all(runId) as { severity: string; n: number }[])
      findingsBySeverity[r.severity] = r.n;
    const notTested = this.db
      .prepare(`SELECT id,url,status FROM nodes WHERE run_id=? AND status IN ('queued','blocked','skipped','in_progress') ORDER BY status`)
      .all(runId) as { id: string; url: string; status: string }[];
    const done = (byStatus.passed ?? 0) + (byStatus.failed ?? 0);
    return { total, byStatus, findingsBySeverity, notTested, coveragePct: total ? Math.round((done / total) * 100) : 0 };
  }

  allNodes(runId: string): NodeRow[] {
    return this.db.prepare(`SELECT * FROM nodes WHERE run_id=? ORDER BY tier, depth, url`).all(runId) as NodeRow[];
  }
  allFindings(runId: string): FindingRow[] {
    return this.db
      .prepare(`SELECT * FROM findings WHERE run_id=? ORDER BY CASE severity WHEN 'S1' THEN 0 WHEN 'S2' THEN 1 WHEN 'S3' THEN 2 WHEN 'S4' THEN 3 ELSE 4 END`)
      .all(runId) as FindingRow[];
  }

  close(): void {
    this.db.close();
  }
}
