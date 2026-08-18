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
import { OPEN_STAGES, isSource, isStage, type Lead, type StageKey } from "./lead-stages";

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
  opts: { stage?: StageKey; ownerId?: number | null; includeClosed?: boolean; search?: string } = {}
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
    `SELECT l.*, u.name AS owner_name
       FROM leads l
       LEFT JOIN users u ON u.id = l.owner_user_id
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
export async function leadSummary(): Promise<{
  open: number;
  overdue: number;
  wonThisMonth: number;
  wonValueThisMonth: number;
} | null> {
  if (!(await leadsReady())) return null;
  const r = await queryOne<Record<string, unknown>>(
    `SELECT
       SUM(stage IN ('new','contacted','qualified','proposal')) AS open_count,
       SUM(stage IN ('new','contacted','qualified','proposal')
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
