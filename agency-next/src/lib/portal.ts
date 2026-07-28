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
};

export async function getPortalOverview(clientId: number): Promise<PortalOverview | null> {
  const client = await queryOne<{ company_name: string }>(
    "SELECT company_name FROM clients WHERE id = ?",
    [clientId]
  );
  if (!client) return null;

  const [month, invoices, awaiting] = await Promise.all([
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
  ]);

  return {
    company_name: client.company_name,
    month: { total: n(month?.total), approved: n(month?.approved), awaiting: n(month?.awaiting) },
    invoices: {
      pending_total: n(invoices?.pending_total),
      pending_count: n(invoices?.pending_count),
    },
    awaiting_items: awaiting,
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
    `SELECT id, client_id, title, description, caption, edited_link, status, service,
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
};

export async function getPortalInvoices(clientId: number): Promise<PortalInvoice[]> {
  const rows = await query<PortalInvoice>(
    `SELECT id, invoice_no, total, status, issue_date, due_date
     FROM invoices WHERE client_id = ? ORDER BY created_at DESC LIMIT 100`,
    [clientId]
  );
  return rows.map((r) => ({ ...r, total: n(r.total) }));
}
