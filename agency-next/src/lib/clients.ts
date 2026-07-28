/** Read queries for the Clients (CRM) module. */
import "server-only";
import { query, queryOne } from "./db";

const n = (v: unknown) => Number(v ?? 0);

export type ClientFull = {
  id: number;
  user_id: number | null;
  company_name: string;
  company_logo_url: string | null;
  contact_person: string | null;
  phone: string | null;
  email: string | null;
  business_type: string | null;
  instagram_link: string | null;
  facebook_link: string | null;
  youtube_link: string | null;
  website: string | null;
  monthly_package: string | null;
  package_amount: number;
  joining_date: string | null;
  renewal_date: string | null;
  monthly_deliverables: number;
  monthly_posters: number;
  payment_plan: string;
  notes: string | null;
  status: string;
  designer_id: number | null;
  caption_settings: unknown;
  placeholder_values: unknown;
  /** JSON array of ServiceKey — signed-up services (filtering/reporting only). */
  services: unknown;
  /** Meta Graph IG business account id — enables Instagram auto-posting for this client. */
  ig_user_id: string | null;
  is_personal: number;
  login_email: string | null;
  login_active: number | null;
};

export type ClientDetail = ClientFull & {
  progress: { total: number; completed: number; posted: number; awaiting_approval: number };
  deliverables: {
    id: number;
    title: string;
    status: string;
    platform: string | null;
    service: string | null;
    video_type: string | null;
    content_category: string | null;
    due_date: string | null;
  }[];
  payments: { total_received: number; pending_amount: number; pending_count: number };
};

export async function getClientDetail(id: number): Promise<ClientDetail | null> {
  const client = await queryOne<ClientFull>(
    `SELECT c.*, u.email AS login_email, u.is_active AS login_active
     FROM clients c LEFT JOIN users u ON u.id = c.user_id WHERE c.id = ?`,
    [id]
  );
  if (!client) return null;

  const [progress, deliverables, payments] = await Promise.all([
    queryOne<Record<string, unknown>>(
      `SELECT COUNT(*) AS total,
        SUM(status = 'completed') AS completed,
        SUM(status IN ('posted','completed')) AS posted,
        SUM(approval_status = 'pending' AND status IN ('review','caption_ready')) AS awaiting_approval
       FROM deliverables WHERE client_id = ? AND month_key = DATE_FORMAT(CURDATE(), '%Y-%m')`,
      [id]
    ),
    query<ClientDetail["deliverables"][number]>(
      `SELECT id, title, status, platform, service, video_type, content_category, due_date
       FROM deliverables
       WHERE client_id = ? ORDER BY id DESC LIMIT 10`,
      [id]
    ),
    queryOne<Record<string, unknown>>(
      `SELECT
        COALESCE(SUM(CASE WHEN status='paid' THEN amount END),0) AS total_received,
        COALESCE(SUM(CASE WHEN status='pending' THEN amount END),0) AS pending_amount,
        SUM(status='pending') AS pending_count
       FROM payments WHERE client_id = ?`,
      [id]
    ),
  ]);

  return {
    ...client,
    package_amount: n(client.package_amount),
    monthly_deliverables: n(client.monthly_deliverables),
    monthly_posters: n(client.monthly_posters),
    progress: {
      total: n(progress?.total),
      completed: n(progress?.completed),
      posted: n(progress?.posted),
      awaiting_approval: n(progress?.awaiting_approval),
    },
    deliverables,
    payments: {
      total_received: n(payments?.total_received),
      pending_amount: n(payments?.pending_amount),
      pending_count: n(payments?.pending_count),
    },
  };
}

export type Designer = { id: number; name: string };

/** Poster designers, for the "default designer" dropdown. */
export async function getDesigners(): Promise<Designer[]> {
  return query<Designer>(
    "SELECT id, name FROM users WHERE role = 'poster_designer' AND is_active = 1 ORDER BY name"
  );
}
