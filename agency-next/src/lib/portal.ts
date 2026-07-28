/** Client-portal queries — all scoped to a single client_id. */
import "server-only";
import { query, queryOne } from "./db";

const n = (v: unknown) => Number(v ?? 0);

export type PortalOverview = {
  company_name: string;
  month: { total: number; approved: number; awaiting: number };
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
    service: string | null;
    video_type: string | null;
    content_category: string | null;
  }[];
};

export async function getPortalOverview(clientId: number): Promise<PortalOverview | null> {
  const client = await queryOne<{ company_name: string }>(
    "SELECT company_name FROM clients WHERE id = ?",
    [clientId]
  );
  if (!client) return null;

  const [month, invoices, awaiting, rawNeeded] = await Promise.all([
    queryOne<Record<string, unknown>>(
      `SELECT COUNT(*) AS total,
        SUM(status IN ('approved','scheduled','posted','completed')) AS approved,
        SUM(status IN ('content_review','review')) AS awaiting
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
      `SELECT id, title, service, video_type, content_category FROM deliverables
       WHERE client_id = ? AND status = 'waiting_for_raw'
       ORDER BY id DESC`,
      [clientId]
    ),
  ]);

  return {
    company_name: client.company_name,
    month: { total: n(month?.total), approved: n(month?.approved), awaiting: n(month?.awaiting) },
    invoices: {
      pending_total: n(invoices?.pending_total),
      pending_count: n(invoices?.pending_count),
    },
    awaiting_items: awaiting,
    raw_needed_items: rawNeeded,
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
  return queryOne<PortalDeliverable>(
    `SELECT id, client_id, title, description, caption, edited_link, cloud_video_url, status, service,
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
