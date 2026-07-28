/**
 * Reusable read queries against the existing agency_erp schema.
 * These mirror the original Express endpoints but run directly inside server
 * components (no HTTP round-trip).
 */
import "server-only";
import { query, queryOne } from "./db";

const n = (v: unknown) => Number(v ?? 0);

/* ------------------------------ Dashboard ------------------------------ */

export type AdminDashboard = {
  clients: { total: number; active: number; new_30d: number };
  deliverables: {
    month_total: number;
    month_completed: number;
    month_pending: number;
    month_dropped: number;
    today: number;
    upcoming: number;
    overdue: number;
  };
  payments: {
    pending_amount: number;
    pending_count: number;
    month_received: number;
    total_received: number;
  };
  pending_approvals: number;
  changes_requested: number;
  recent_activities: {
    actor_name: string | null;
    action: string;
    entity_type: string | null;
    description: string | null;
    created_at: string;
  }[];
  upcoming_tasks: {
    id: number;
    title: string;
    due_date: string | null;
    status: string;
    platform: string | null;
    service: string | null;
    video_type: string | null;
    content_category: string | null;
    company_name: string;
  }[];
  client_progress: {
    id: number;
    company_name: string;
    monthly_deliverables: number;
    planned: number;
    completed: number;
  }[];
};

export async function getAdminDashboard(): Promise<AdminDashboard> {
  const [clients, deliverables, payments, approvals, activities, upcoming, progress] =
    await Promise.all([
      queryOne<Record<string, unknown>>(
        `SELECT COUNT(*) AS total,
          SUM(status='active') AS active,
          SUM(created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)) AS new_30d
         FROM clients WHERE status != 'churned'`
      ),
      queryOne<Record<string, unknown>>(
        `SELECT
          SUM(month_key = DATE_FORMAT(CURDATE(), '%Y-%m')) AS month_total,
          SUM(month_key = DATE_FORMAT(CURDATE(), '%Y-%m')
              AND status IN ('approved','scheduled','posted','completed')) AS month_completed,
          SUM(month_key = DATE_FORMAT(CURDATE(), '%Y-%m')
              AND status NOT IN ('approved','scheduled','posted','completed','cancelled','rejected')) AS month_pending,
          SUM(month_key = DATE_FORMAT(CURDATE(), '%Y-%m')
              AND status IN ('cancelled','rejected')) AS month_dropped,
          SUM(due_date = CURDATE() AND status NOT IN ('posted','completed','cancelled','rejected')) AS today,
          SUM(due_date > CURDATE() AND status NOT IN ('posted','completed','cancelled','rejected')) AS upcoming,
          SUM(due_date < CURDATE() AND status NOT IN ('posted','completed','cancelled','rejected')) AS overdue
         FROM deliverables`
      ),
      queryOne<Record<string, unknown>>(
        `SELECT
          COALESCE(SUM(CASE WHEN status='pending' THEN amount END),0) AS pending_amount,
          SUM(status='pending') AS pending_count,
          COALESCE(SUM(CASE WHEN status='paid'
            AND DATE_FORMAT(paid_at,'%Y-%m') = DATE_FORMAT(CURDATE(),'%Y-%m') THEN amount END),0) AS month_received,
          COALESCE(SUM(CASE WHEN status='paid' THEN amount END),0) AS total_received
         FROM payments`
      ),
      queryOne<Record<string, unknown>>(
        `SELECT
          COALESCE(SUM(status IN ('content_review','review')),0) AS awaiting,
          COALESCE(SUM(status = 'changes_requested'),0) AS changes
         FROM deliverables`
      ),
      query<AdminDashboard["recent_activities"][number]>(
        `SELECT actor_name, action, entity_type, entity_id, description, created_at
         FROM activity_logs ORDER BY id DESC LIMIT 12`
      ),
      query<AdminDashboard["upcoming_tasks"][number]>(
        `SELECT d.id, d.title, d.due_date, d.status, d.platform, d.service,
                d.video_type, d.content_category, c.company_name
         FROM deliverables d JOIN clients c ON c.id = d.client_id
         WHERE d.due_date >= CURDATE() AND d.status NOT IN ('posted','completed','cancelled','rejected')
         ORDER BY d.due_date ASC LIMIT 8`
      ),
      query<AdminDashboard["client_progress"][number]>(
        `SELECT c.id, c.company_name, c.monthly_deliverables,
          COALESCE(SUM(d.month_key = DATE_FORMAT(CURDATE(), '%Y-%m')),0) AS planned,
          COALESCE(SUM(d.month_key = DATE_FORMAT(CURDATE(), '%Y-%m') AND d.status IN ('posted','completed')),0) AS completed
         FROM clients c
         LEFT JOIN deliverables d ON d.client_id = c.id
         WHERE c.status = 'active'
         GROUP BY c.id ORDER BY c.company_name LIMIT 10`
      ),
    ]);

  return {
    clients: {
      total: n(clients?.total),
      active: n(clients?.active),
      new_30d: n(clients?.new_30d),
    },
    deliverables: {
      month_total: n(deliverables?.month_total),
      month_completed: n(deliverables?.month_completed),
      month_pending: n(deliverables?.month_pending),
      month_dropped: n(deliverables?.month_dropped),
      today: n(deliverables?.today),
      upcoming: n(deliverables?.upcoming),
      overdue: n(deliverables?.overdue),
    },
    payments: {
      pending_amount: n(payments?.pending_amount),
      pending_count: n(payments?.pending_count),
      month_received: n(payments?.month_received),
      total_received: n(payments?.total_received),
    },
    pending_approvals: n(approvals?.awaiting),
    changes_requested: n(approvals?.changes),
    recent_activities: activities.map((a) => ({ ...a, action: String(a.action) })),
    upcoming_tasks: upcoming,
    client_progress: progress.map((p) => ({
      ...p,
      monthly_deliverables: n(p.monthly_deliverables),
      planned: n(p.planned),
      completed: n(p.completed),
    })),
  };
}

/* --------------------------- Service mix --------------------------- */

export type ServiceMixRow = {
  service: string;
  open: number;
  overdue: number;
  month_total: number;
};

/**
 * This month's workload split by service — the dashboard's "what kind of work
 * is on the floor" row. Legacy rows with a NULL service fall back the same way
 * `serviceOf()` does, so nothing is invisible.
 */
export async function getServiceMix(): Promise<ServiceMixRow[]> {
  // The service tag is derived per row in a subquery first — grouping by a
  // derived column directly trips MySQL's ONLY_FULL_GROUP_BY.
  const rows = await query<Record<string, unknown>>(
    `SELECT t.service,
       COALESCE(SUM(t.status NOT IN ('posted','completed','cancelled','rejected')),0) AS open_count,
       COALESCE(SUM(t.due_date < CURDATE()
         AND t.status NOT IN ('posted','completed','cancelled','rejected')),0) AS overdue,
       COALESCE(SUM(t.month_key = DATE_FORMAT(CURDATE(), '%Y-%m')),0) AS month_total
     FROM (
       SELECT COALESCE(NULLIF(d.service,''),
                IF(LOWER(COALESCE(d.video_type,'')) = 'poster','poster_designing','video_editing')
              ) AS service,
              d.status, d.due_date, d.month_key
       FROM deliverables d JOIN clients c ON c.id = d.client_id
       WHERE c.status != 'churned'
     ) t
     GROUP BY t.service`
  );
  return rows.map((r) => ({
    service: String(r.service),
    open: n(r.open_count),
    overdue: n(r.overdue),
    month_total: n(r.month_total),
  }));
}

/* ------------------------- Production summary ------------------------- */

export type ProductionRow = {
  id: number;
  company_name: string;
  required: number;
  designed: number;
  approved: number;
  awaiting: number;
  changes: number;
  pending: number;
};

/**
 * Per-client content production summary for the current month — mirrors the
 * old app's "Graphic Videos" board:
 *   Required (monthly target) · Designed (produced) · Approved ·
 *   Pending Approvals (on client's desk) · Changes Recommended · Pending (target − designed).
 */
export async function getProductionSummary(): Promise<ProductionRow[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT c.id, c.company_name, c.monthly_deliverables AS required,
       COALESCE(COUNT(d.id),0) AS designed,
       COALESCE(SUM(d.status IN ('approved','scheduled','posted','completed')),0) AS approved,
       COALESCE(SUM(d.status IN ('content_review','review')),0) AS awaiting,
       COALESCE(SUM(d.status = 'changes_requested'),0) AS changes
     FROM clients c
     LEFT JOIN deliverables d
       ON d.client_id = c.id AND d.month_key = DATE_FORMAT(CURDATE(), '%Y-%m')
       AND d.status NOT IN ('cancelled','rejected')
     WHERE c.status != 'churned'
     GROUP BY c.id ORDER BY c.company_name`
  );
  return rows.map((r) => {
    const required = n(r.required);
    const designed = n(r.designed);
    return {
      id: n(r.id),
      company_name: String(r.company_name),
      required,
      designed,
      approved: n(r.approved),
      awaiting: n(r.awaiting),
      changes: n(r.changes),
      pending: Math.max(0, required - designed),
    };
  });
}

/* ------------------------------- Clients ------------------------------- */

export type ClientRow = {
  id: number;
  company_name: string;
  contact_person: string | null;
  email: string | null;
  phone: string | null;
  status: string;
  monthly_package: number | null;
  monthly_deliverables: number;
  renewal_date: string | null;
  created_at: string;
};

/** `clientIds` scopes the list for a crm user; omit/null for unrestricted (admin). */
export async function getClients(clientIds?: number[] | null): Promise<ClientRow[]> {
  if (clientIds && clientIds.length === 0) return [];
  const scope = clientIds && clientIds.length ? `AND id IN (${clientIds.map(() => "?").join(",")})` : "";
  const rows = await query<ClientRow>(
    `SELECT id, company_name, contact_person, email, phone, status,
       monthly_package, monthly_deliverables, renewal_date, created_at
     FROM clients
     WHERE status != 'churned' ${scope}
     ORDER BY (status='active') DESC, company_name ASC`,
    clientIds && clientIds.length ? clientIds : []
  );
  return rows.map((r) => ({
    ...r,
    monthly_deliverables: n(r.monthly_deliverables),
    monthly_package: r.monthly_package == null ? null : n(r.monthly_package),
  }));
}
