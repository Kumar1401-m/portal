/**
 * The enquiries that have not become clients yet.
 *
 * Everything else in this portal starts at the point somebody has already
 * signed. The month before that — the DM, the referral, the quote that went
 * out and was never chased — lived in a notebook and a WhatsApp thread, which
 * is why the honest answer to "what happened to that enquiry" was usually
 * nothing.
 *
 * One table, one row per lead, a stage on it. Not a second contacts model and
 * not a notes timeline: what loses a lead is nobody following it up on the
 * day they said they would, so the only fields that earn their place are the
 * ones that answer *who is chasing this, and when*.
 */
import "server-only";
import { query, queryOne, execute, hasTable } from "./db";
import {
  LEAD_STAGES,
  OPEN_STAGES,
  funnel,
  isSource,
  isStage,
  type Funnel,
  type Lead,
  type StageKey,
} from "./lead-stages";

/*
 * The vocabulary lives next door, where the board — a client component — can
 * reach it without dragging the database driver into the browser bundle.
 * Re-exported so a server caller still has one import for the whole subject.
 */
export * from "./lead-stages";

export const leadsReady = () => hasTable("leads");


/* ------------------------------- Reading ------------------------------- */

const num = (v: unknown) => Number(v ?? 0);

const mapLead = (r: Record<string, unknown>): Lead => ({
  id: num(r.id),
  name: String(r.name ?? ""),
  company: r.company ? String(r.company) : null,
  phone: r.phone ? String(r.phone) : null,
  email: r.email ? String(r.email) : null,
  source: String(r.source ?? "manual"),
  stage: (isStage(String(r.stage)) ? String(r.stage) : "new") as StageKey,
  value: num(r.value),
  owner_user_id: r.owner_user_id ? num(r.owner_user_id) : null,
  owner_name: r.owner_name ? String(r.owner_name) : null,
  client_name: r.client_name ? String(r.client_name) : null,
  next_follow_up: r.next_follow_up ? String(r.next_follow_up).slice(0, 10) : null,
  note: r.note ? String(r.note) : null,
  lost_reason: r.lost_reason ? String(r.lost_reason) : null,
  client_id: r.client_id ? num(r.client_id) : null,
  created_at: String(r.created_at ?? ""),
  updated_at: String(r.updated_at ?? ""),
});

/**
 * The board.
 *
 * `ownerId` scopes it to one person's leads — what a crm sees, because a
 * pipeline is a personal worklist before it is a report. Closed leads are off
 * by default: won and lost are history, and history at the top of a list of
 * things to do is how the things to do get missed.
 */
export async function getLeads(
  opts: {
    stage?: StageKey;
    ownerId?: number | null;
    includeClosed?: boolean;
    search?: string;
    /** One client's leads — the ads that ran for them are what produced these. */
    clientId?: number | null;
    /** The clients this user may see at all, or null for everybody. */
    clientIds?: number[] | null;
  } = {}
): Promise<Lead[]> {
  if (!(await leadsReady())) return [];

  const where: string[] = ["1=1"];
  const params: (string | number)[] = [];

  if (opts.stage) {
    where.push("l.stage = ?");
    params.push(opts.stage);
  } else if (!opts.includeClosed) {
    where.push(`l.stage IN (${OPEN_STAGES.map(() => "?").join(",")})`);
    params.push(...OPEN_STAGES);
  }
  /*
   * Whose lead this is — which on an agency's board is a different question
   * from whose desk it sits on. A lead exists because an ad ran for a client,
   * and without this the board is every client's leads in one list, so the
   * question anybody actually asks — "what did we get them this month?" —
   * cannot be asked at all.
   */
  if (opts.clientId) {
    where.push("l.client_id = ?");
    params.push(opts.clientId);
  }
  if (opts.clientIds) {
    if (opts.clientIds.length === 0) return [];
    where.push(`l.client_id IN (${opts.clientIds.map(() => "?").join(",")})`);
    params.push(...opts.clientIds);
  }
  if (opts.ownerId) {
    where.push("l.owner_user_id = ?");
    params.push(opts.ownerId);
  }
  if (opts.search) {
    where.push("(l.name LIKE ? OR l.company LIKE ? OR l.phone LIKE ? OR l.email LIKE ?)");
    const like = `%${opts.search}%`;
    params.push(like, like, like, like);
  }

  const rows = await query<Record<string, unknown>>(
    `SELECT l.*, u.name AS owner_name, c.company_name AS client_name
       FROM leads l
       LEFT JOIN users u ON u.id = l.owner_user_id
       LEFT JOIN clients c ON c.id = l.client_id
      WHERE ${where.join(" AND ")}
      /* Whoever is overdue first, then by the day they are due. A lead with
         no follow-up date set is not urgent, it is unplanned — it goes last
         rather than to the top on a NULL sort. */
      ORDER BY (l.next_follow_up IS NULL), l.next_follow_up ASC, l.created_at DESC
      LIMIT 300`,
    params
  );
  return rows.map(mapLead);
}

export async function getLead(id: number): Promise<Lead | null> {
  if (!(await leadsReady())) return null;
  const r = await queryOne<Record<string, unknown>>(
    `SELECT l.*, u.name AS owner_name FROM leads l
       LEFT JOIN users u ON u.id = l.owner_user_id WHERE l.id = ?`,
    [Math.trunc(id)]
  );
  return r ? mapLead(r) : null;
}

/** Won this month, and what it was worth. For the dashboard and the assistant. */
/** `'a','b'` — OPEN_STAGES for an IN clause. Our own constants, never input. */
const OPEN_LIST = OPEN_STAGES.map((s) => `'${s}'`).join(",");

export async function leadSummary(): Promise<{
  open: number;
  overdue: number;
  wonThisMonth: number;
  wonValueThisMonth: number;
} | null> {
  if (!(await leadsReady())) return null;
  const r = await queryOne<Record<string, unknown>>(
    `SELECT
       /* One definition of "open", shared with the board and the filters —
          three hardcoded copies of this list is how a new stage ends up
          counted on one screen and invisible on another. */
       SUM(stage IN (${OPEN_LIST})) AS open_count,
       SUM(stage IN (${OPEN_LIST})
           AND next_follow_up IS NOT NULL AND next_follow_up < CURDATE()) AS overdue,
       SUM(stage = 'won' AND DATE_FORMAT(updated_at,'%Y-%m') = DATE_FORMAT(CURDATE(),'%Y-%m')) AS won_count,
       COALESCE(SUM(CASE WHEN stage = 'won'
         AND DATE_FORMAT(updated_at,'%Y-%m') = DATE_FORMAT(CURDATE(),'%Y-%m') THEN value END),0) AS won_value
     FROM leads`
  );
  return {
    open: num(r?.open_count),
    overdue: num(r?.overdue),
    wonThisMonth: num(r?.won_count),
    wonValueThisMonth: num(r?.won_value),
  };
}

/* ------------------------------- Writing ------------------------------- */

export type LeadInput = {
  name: string;
  company?: string | null;
  phone?: string | null;
  email?: string | null;
  source?: string;
  stage?: StageKey;
  value?: number;
  ownerId?: number | null;
  nextFollowUp?: string | null;
  note?: string | null;
};

export async function createLead(input: LeadInput): Promise<number> {
  const res = await execute(
    `INSERT INTO leads (name, company, phone, email, source, stage, value,
                        owner_user_id, next_follow_up, note)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      input.name.slice(0, 150),
      input.company?.slice(0, 190) || null,
      input.phone?.slice(0, 32) || null,
      input.email?.slice(0, 190) || null,
      input.source && isSource(input.source) ? input.source : "manual",
      input.stage && isStage(input.stage) ? input.stage : "new",
      Number.isFinite(input.value) ? Number(input.value) : 0,
      input.ownerId ?? null,
      input.nextFollowUp || null,
      input.note?.slice(0, 4000) || null,
    ]
  );
  return Number(res.insertId) || 0;
}

/**
 * Move a lead along.
 *
 * `lost_reason` is cleared on any move out of "lost" — a lead that comes back
 * to life carrying "budget" as its reason would show that against every later
 * stage it reaches.
 */
export async function setStage(id: number, stage: StageKey, lostReason?: string | null): Promise<void> {
  await execute("UPDATE leads SET stage = ?, lost_reason = ? WHERE id = ?", [
    stage,
    stage === "lost" ? (lostReason?.slice(0, 190) || null) : null,
    Math.trunc(id),
  ]);
}

/** Duplicate check for the API — the same enquiry arriving twice from a form. */
export async function findByContact(phone: string | null, email: string | null): Promise<number | null> {
  if (!phone && !email) return null;
  const r = await queryOne<{ id: number }>(
    `SELECT id FROM leads
      WHERE (? IS NOT NULL AND phone = ?) OR (? IS NOT NULL AND email = ?)
      ORDER BY id DESC LIMIT 1`,
    [phone, phone, email, email]
  );
  return r ? Number(r.id) : null;
}

/**
 * The funnel, counted in the database rather than by loading the leads.
 *
 * The board used to build every number on it — the open pipeline, each stage
 * chip, the won value, the overdue count — by fetching leads and adding them
 * up in memory. `getLeads` has a `LIMIT 300`, which is right for a list and
 * catastrophic for a total: past three hundred leads every figure on the page
 * silently stopped growing. Not wrong in a way anybody would notice, either —
 * it just quietly plateaued at a plausible number, on the one board whose
 * whole job is to say how much work is coming in.
 *
 * Ads produce leads, and an agency running lead-gen crosses three hundred
 * quickly, so this was a bug with a date on it.
 *
 * Same filters as the list so the two agree, same shape as `funnel()` so the
 * board did not have to change how it reads them, and no limit — a COUNT does
 * not need one.
 */
export async function leadFunnel(opts: {
  clientId?: number | null;
  clientIds?: number[] | null;
  search?: string;
  ownerId?: number | null;
} = {}): Promise<Funnel> {
  const blank = funnel([], "1970-01-01");
  if (!(await leadsReady())) return blank;

  const where: string[] = ["1=1"];
  const params: (string | number)[] = [];

  if (opts.clientId) {
    where.push("l.client_id = ?");
    params.push(opts.clientId);
  }
  if (opts.clientIds) {
    if (opts.clientIds.length === 0) return blank;
    where.push(`l.client_id IN (${opts.clientIds.map(() => "?").join(",")})`);
    params.push(...opts.clientIds);
  }
  if (opts.ownerId) {
    where.push("l.owner_user_id = ?");
    params.push(opts.ownerId);
  }
  if (opts.search) {
    where.push("(l.name LIKE ? OR l.company LIKE ? OR l.phone LIKE ? OR l.email LIKE ?)");
    const like = `%${opts.search}%`;
    params.push(like, like, like, like);
  }

  /*
   * CURDATE() is the database's clock, which runs on Indian time here — and
   * that is the right one: `next_follow_up` is a date somebody typed while
   * sitting in India, not a moment in UTC. Comparing it against the app's UTC
   * day would make every follow-up look overdue for five and a half hours
   * every night.
   */
  const rows = await query<{
    stage: string;
    n: number;
    value: string | null;
    overdue: number;
    due_today: number;
  }>(
    `SELECT l.stage,
            COUNT(*) AS n,
            COALESCE(SUM(l.value), 0) AS value,
            COALESCE(SUM(l.next_follow_up IS NOT NULL AND l.next_follow_up < CURDATE()), 0) AS overdue,
            COALESCE(SUM(l.next_follow_up = CURDATE()), 0) AS due_today
       FROM leads l
      WHERE ${where.join(" AND ")}
      GROUP BY l.stage`,
    params
  ).catch(() => []);

  const stages = LEAD_STAGES.map((s) => ({ key: s.key, label: s.label, count: 0, value: 0 }));
  const at = new Map(stages.map((s) => [s.key, s]));

  let openValue = 0;
  let wonValue = 0;
  let overdue = 0;
  let dueToday = 0;

  for (const r of rows) {
    const bucket = at.get(r.stage as StageKey);
    const n = Number(r.n) || 0;
    const value = Number(r.value) || 0;
    if (bucket) {
      bucket.count = n;
      bucket.value = value;
    }
    if (r.stage === "won") {
      wonValue += value;
    } else if (r.stage !== "lost") {
      // Only an open lead can be overdue. A lost one whose follow-up date
      // passed is not a task anybody has to do — same rule as `funnel()`.
      openValue += value;
      overdue += Number(r.overdue) || 0;
      dueToday += Number(r.due_today) || 0;
    }
  }

  const won = at.get("won")?.count ?? 0;
  const lost = at.get("lost")?.count ?? 0;
  const closed = won + lost;

  return {
    stages,
    openValue,
    wonValue,
    // Against everything that has *closed*, not against every lead ever — a
    // pipeline full of live enquiries would otherwise drag the rate down for
    // the crime of being busy. Same rule as `funnel()`.
    conversion: closed > 0 ? Math.round((won / closed) * 100) : null,
    overdue,
    dueToday,
  };
}
