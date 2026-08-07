/** Client-portal queries — all scoped to a single client_id. */
import "server-only";
import { query, queryOne, hasColumn } from "./db";

const n = (v: unknown) => Number(v ?? 0);

/**
 * Statuses a client may still attach footage to.
 *
 * `waiting_for_raw` is the case where we asked for it. `pending` is a slot on
 * the month's plan that nobody has asked about yet — and a client who already
 * has the footage should not have to wait to be asked before sending the link.
 *
 * Lives here rather than beside the action because the dashboard query that
 * decides what to offer and the action that accepts it must agree; a button
 * offered and then refused is the worst version of this.
 */
export const ACCEPTS_RAW = ["waiting_for_raw", "pending"] as const;

const ACCEPTS_RAW_SQL = ACCEPTS_RAW.map((s) => `'${s}'`).join(",");

export type PortalPostedItem = {
  id: number;
  title: string;
  service: string | null;
  video_type: string | null;
  content_category: string | null;
  /** When it went live, or when it is due to. */
  when: string | null;
  /** The post itself, when Instagram gave us one back. */
  permalink: string | null;
};

export type PortalOverview = {
  company_name: string;
  month: { total: number; approved: number; awaiting: number; posted: number };
  invoices: { pending_total: number; pending_count: number };
  awaiting_items: {
    id: number;
    title: string;
    status: string;
    service: string | null;
    video_type: string | null;
    content_category: string | null;
  }[];
  raw_needed_items: {
    id: number;
    title: string;
    /** Which kind: one we asked for, or an unstarted slot on the plan. */
    status: string;
    service: string | null;
    video_type: string | null;
    content_category: string | null;
  }[];
  /** Already live. */
  posted_items: PortalPostedItem[];
  /** Approved and dated, but not out yet. */
  scheduled_items: PortalPostedItem[];
};

export async function getPortalOverview(clientId: number): Promise<PortalOverview | null> {
  const client = await queryOne<{ company_name: string }>(
    "SELECT company_name FROM clients WHERE id = ?",
    [clientId]
  );
  if (!client) return null;

  // The Instagram columns arrive with a later migration, so a database that
  // has not run it still gets a working dashboard — just without permalinks.
  const hasIg = await hasColumn("deliverables", "instagram_permalink");
  const permalink = hasIg ? "d.instagram_permalink" : "NULL";
  const igPosted = hasIg ? "d.instagram_posted_at" : "NULL";

  const [month, invoices, awaiting, rawNeeded, posted, scheduled] = await Promise.all([
    queryOne<Record<string, unknown>>(
      `SELECT COUNT(*) AS total,
        SUM(status IN ('approved','scheduled','posted','completed')) AS approved,
        SUM(status IN ('content_review','review')) AS awaiting,
        SUM(status IN ('posted','completed')) AS posted
       FROM deliverables WHERE client_id = ? AND month_key = DATE_FORMAT(CURDATE(),'%Y-%m')`,
      [clientId]
    ),
    queryOne<Record<string, unknown>>(
      `SELECT COALESCE(SUM(CASE WHEN status!='paid' THEN total END),0) AS pending_total,
        SUM(status!='paid') AS pending_count
       FROM invoices WHERE client_id = ?`,
      [clientId]
    ),
    query<PortalOverview["awaiting_items"][number]>(
      `SELECT id, title, status, service, video_type, content_category FROM deliverables
       WHERE client_id = ? AND status IN ('content_review','review')
       ORDER BY id DESC`,
      [clientId]
    ),
    query<PortalOverview["raw_needed_items"][number]>(
      // Anything not yet being cut and with no link on it. A slot on the
      // month's plan counts: the client having the footage is not a reason to
      // wait until somebody asks for it.
      `SELECT id, title, status, service, video_type, content_category FROM deliverables
       WHERE client_id = ? AND status IN (${ACCEPTS_RAW_SQL})
         AND (raw_drive_link IS NULL OR raw_drive_link = '')
       ORDER BY due_date IS NULL, due_date ASC, id ASC`,
      [clientId]
    ),
    query<PortalPostedItem>(
      `SELECT d.id, d.title, d.service, d.video_type, d.content_category,
              COALESCE(${igPosted}, d.posted_at) AS \`when\`,
              ${permalink} AS permalink
         FROM deliverables d
        WHERE d.client_id = ? AND d.status IN ('posted','completed')
        ORDER BY COALESCE(${igPosted}, d.posted_at) IS NULL,
                 COALESCE(${igPosted}, d.posted_at) DESC, d.id DESC
        LIMIT 12`,
      [clientId]
    ),
    query<PortalPostedItem>(
      // Approved and dated but not out yet — the answer to "when is mine going
      // up", which is the question the posted list raises.
      `SELECT d.id, d.title, d.service, d.video_type, d.content_category,
              d.scheduled_at AS \`when\`, NULL AS permalink
         FROM deliverables d
        WHERE d.client_id = ? AND d.status IN ('approved','scheduled')
        ORDER BY d.scheduled_at IS NULL, d.scheduled_at ASC, d.id DESC
        LIMIT 12`,
      [clientId]
    ),
  ]);

  return {
    company_name: client.company_name,
    month: {
      total: n(month?.total),
      approved: n(month?.approved),
      awaiting: n(month?.awaiting),
      posted: n(month?.posted),
    },
    invoices: {
      pending_total: n(invoices?.pending_total),
      pending_count: n(invoices?.pending_count),
    },
    awaiting_items: awaiting,
    raw_needed_items: rawNeeded,
    posted_items: posted,
    scheduled_items: scheduled,
  };
}

export type PortalContentRow = {
  id: number;
  title: string;
  status: string;
  service: string | null;
  video_type: string | null;
  content_category: string | null;
  platform: string | null;
  due_date: string | null;
};

export async function getPortalContent(clientId: number): Promise<PortalContentRow[]> {
  return query<PortalContentRow>(
    `SELECT id, title, status, service, video_type, content_category, platform, due_date
     FROM deliverables WHERE client_id = ?
     ORDER BY FIELD(status,'content_review','review','changes_requested') DESC, id DESC
     LIMIT 100`,
    [clientId]
  );
}

export type PortalDeliverable = {
  id: number;
  client_id: number;
  title: string;
  description: string | null;
  caption: string | null;
  edited_link: string | null;
  cloud_video_url: string | null;
  cloud_video_key: string | null;
  status: string;
  service: string | null;
  video_type: string | null;
  content_category: string | null;
  platform: string | null;
  due_date: string | null;
  reject_reason: string | null;
};

export async function getPortalDeliverable(
  clientId: number,
  id: number
): Promise<PortalDeliverable | null> {
  const cloud = (await hasColumn("deliverables", "cloud_video_url"))
    ? "cloud_video_url, cloud_video_key"
    : "NULL AS cloud_video_url, NULL AS cloud_video_key";
  return queryOne<PortalDeliverable>(
    `SELECT id, client_id, title, description, caption, edited_link, ${cloud}, status, service,
            video_type, content_category, platform, due_date, reject_reason
     FROM deliverables WHERE id = ? AND client_id = ?`,
    [id, clientId]
  );
}

export type PortalInvoice = {
  id: number;
  invoice_no: string;
  total: number;
  status: string;
  issue_date: string | null;
  due_date: string | null;
  pending_payment_id: number | null;
};

export async function getPortalInvoices(clientId: number): Promise<PortalInvoice[]> {
  const rows = await query<PortalInvoice>(
    `SELECT i.id, i.invoice_no, i.total, i.status, i.issue_date, i.due_date,
            (SELECT p.id FROM payments p WHERE p.invoice_id = i.id AND p.status = 'pending'
              ORDER BY p.id DESC LIMIT 1) AS pending_payment_id
     FROM invoices i WHERE i.client_id = ? ORDER BY i.created_at DESC LIMIT 100`,
    [clientId]
  );
  return rows.map((r) => ({
    ...r,
    total: n(r.total),
    pending_payment_id: r.pending_payment_id == null ? null : n(r.pending_payment_id),
  }));
}

export type PortalClientInfo = { company_name: string; email: string | null };

export async function getPortalClientInfo(clientId: number): Promise<PortalClientInfo | null> {
  return queryOne<PortalClientInfo>("SELECT company_name, email FROM clients WHERE id = ?", [clientId]);
}

export type PortalActionCounts = { content: number; invoices: number };

/** Lightweight counts for nav badges — content needing review/footage, unpaid invoices. */
export async function getPortalActionCounts(clientId: number): Promise<PortalActionCounts> {
  const [content, invoices] = await Promise.all([
    queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM deliverables
       WHERE client_id = ? AND status IN ('content_review','review','waiting_for_raw')`,
      [clientId]
    ),
    queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM invoices WHERE client_id = ? AND status != 'paid'", [
      clientId,
    ]),
  ]);
  return { content: n(content?.n), invoices: n(invoices?.n) };
}
