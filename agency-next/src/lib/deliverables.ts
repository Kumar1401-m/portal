/** Read/write queries for the deliverables (content) module. */
import "server-only";
import { query, queryOne } from "./db";
import type { CaptionSource } from "./ai";
import { SERVICE_KEYS, serviceOf, type ServiceKey } from "./services";

const n = (v: unknown) => Number(v ?? 0);

export type DeliverableListRow = {
  id: number;
  client_id: number;
  title: string;
  platform: string | null;
  video_type: string | null;
  service: string | null;
  content_category: string | null;
  status: string;
  priority: string;
  due_date: string | null;
  month_key: string | null;
  ai_score: number | null;
  company_name: string;
  assigned_to: number | null;
  assignee_name: string | null;
  // Editable fields surfaced for the quick-edit modal:
  content_hook: string | null;
  caption: string | null;
  description: string | null;
  writer_notes: string | null;
  videographer_notes: string | null;
  thumbnail_url: string | null;
  edited_link: string | null;
  promotion_type: string | null;
  raw_drive_link: string | null;
  reject_reason: string | null;
};

export type DeliverableFilters = {
  status?: string;
  clientId?: number;
  month?: string;
  q?: string;
  today?: boolean; // due today or overdue, still open
  assignedTo?: number; // scope to one owner (poster designers)
  service?: ServiceKey; // task organisation: one service per tab
  category?: string;
  dueFrom?: string; // YYYY-MM-DD
  dueTo?: string; // YYYY-MM-DD
  /** crm role scoping: null/omitted = unrestricted, [] = no access to anything. */
  crmClientIds?: number[] | null;
};

/**
 * SQL for "this row belongs to <service>". Rows created before the taxonomy
 * existed have a NULL `service`, so mirror the `serviceOf()` fallback here —
 * legacy posters stay under Posters, everything else under Videos.
 */
function serviceCond(service: ServiceKey): string {
  if (service === "poster_designing") {
    return "(d.service = 'poster_designing' OR (d.service IS NULL AND LOWER(COALESCE(d.video_type,'')) = 'poster'))";
  }
  if (service === "video_editing") {
    return "(d.service = 'video_editing' OR (d.service IS NULL AND LOWER(COALESCE(d.video_type,'')) <> 'poster'))";
  }
  return "d.service = ?";
}

/** Build the shared WHERE clause for the list and the tab counts. */
function buildWhere(f: DeliverableFilters): { where: string; params: (string | number)[] } {
  const conds: string[] = [];
  const params: (string | number)[] = [];

  if (f.clientId) {
    conds.push("d.client_id = ?");
    params.push(f.clientId);
  } else {
    conds.push("c.status != 'churned'");
  }
  if (f.status) {
    conds.push("d.status = ?");
    params.push(f.status);
  }
  if (f.month) {
    conds.push("d.month_key = ?");
    params.push(f.month);
  }
  if (f.q) {
    conds.push("(d.title LIKE ? OR d.caption LIKE ?)");
    params.push(`%${f.q}%`, `%${f.q}%`);
  }
  if (f.assignedTo) {
    conds.push("d.assigned_to = ?");
    params.push(f.assignedTo);
  }
  if (f.category) {
    conds.push("d.content_category = ?");
    params.push(f.category);
  }
  if (f.dueFrom) {
    conds.push("d.due_date >= ?");
    params.push(f.dueFrom);
  }
  if (f.dueTo) {
    conds.push("d.due_date <= ?");
    params.push(f.dueTo);
  }
  if (f.today) {
    conds.push(
      "d.due_date <= CURDATE() AND d.status NOT IN ('posted','completed','cancelled','rejected')"
    );
  }
  if (f.service) {
    const cond = serviceCond(f.service);
    conds.push(cond);
    if (cond.includes("?")) params.push(f.service);
  }
  if (f.crmClientIds !== undefined && f.crmClientIds !== null) {
    if (f.crmClientIds.length === 0) {
      conds.push("1=0");
    } else {
      conds.push(`d.client_id IN (${f.crmClientIds.map(() => "?").join(",")})`);
      params.push(...f.crmClientIds);
    }
  }

  return { where: conds.length ? `WHERE ${conds.join(" AND ")}` : "", params };
}

/** Admin/staff deliverables list with filters (churned clients hidden by default). */
export async function getDeliverables(
  f: DeliverableFilters = {}
): Promise<DeliverableListRow[]> {
  const { where, params } = buildWhere(f);
  const rows = await query<DeliverableListRow>(
    `SELECT d.id, d.client_id, d.title, d.platform, d.video_type, d.service,
            d.content_category, d.status, d.priority,
            d.due_date, d.month_key, d.ai_score, c.company_name,
            d.assigned_to, u.name AS assignee_name,
            d.content_hook, d.caption, d.description, d.writer_notes,
            d.videographer_notes, d.thumbnail_url, d.edited_link,
            d.promotion_type, d.raw_drive_link, d.reject_reason
     FROM deliverables d
     JOIN clients c ON c.id = d.client_id
     LEFT JOIN users u ON u.id = d.assigned_to
     ${where}
     ORDER BY d.due_date IS NULL, d.due_date ASC,
              FIELD(d.priority,'urgent','high','medium','low'), d.id DESC
     LIMIT 200`,
    params
  );
  return rows.map((r) => ({ ...r, ai_score: r.ai_score == null ? null : n(r.ai_score) }));
}

export type ServiceCounts = Record<ServiceKey | "all", number>;

/**
 * How many tasks sit behind each service tab, under the *other* active filters
 * (so the badges match what you'd actually see after clicking).
 */
export async function getServiceCounts(f: DeliverableFilters = {}): Promise<ServiceCounts> {
  const { where, params } = buildWhere({ ...f, service: undefined });
  const legacyPoster = "(d.service IS NULL AND LOWER(COALESCE(d.video_type,'')) = 'poster')";
  const legacyVideo = "(d.service IS NULL AND LOWER(COALESCE(d.video_type,'')) <> 'poster')";

  const row = await queryOne<Record<string, unknown>>(
    `SELECT COUNT(*) AS all_count,
       COALESCE(SUM(d.service = 'video_editing' OR ${legacyVideo}),0)        AS video_editing,
       COALESCE(SUM(d.service = 'poster_designing' OR ${legacyPoster}),0)    AS poster_designing,
       COALESCE(SUM(d.service = 'meta_ads'),0)                               AS meta_ads,
       COALESCE(SUM(d.service = 'content_writing'),0)                        AS content_writing
     FROM deliverables d JOIN clients c ON c.id = d.client_id
     ${where}`,
    params
  );

  const out = { all: n(row?.all_count) } as ServiceCounts;
  for (const k of SERVICE_KEYS) out[k] = n(row?.[k]);
  return out;
}

export type Assignee = { id: number; name: string; role: string };

/** Staff who can own a task — for the "Assigned to" filter and forms. */
export async function getAssignees(): Promise<Assignee[]> {
  return query<Assignee>(
    `SELECT id, name, role FROM users
     WHERE role IN ('super_admin','admin','poster_designer') AND is_active = 1
     ORDER BY name`
  );
}

/** Re-export so pages can tag a row without importing two modules. */
export { serviceOf };

export type DeliverableDetail = CaptionSource & {
  status: string;
  priority: string;
  due_date: string | null;
  caption: string | null;
  edited_link: string | null;
  raw_drive_link: string | null;
  reject_reason: string | null;
  ai_score: number | null;
  service: string | null;
  content_category: string | null;
  assigned_to: number | null;
  created_at: string;
};

/** Full deliverable + the client fields needed for the caption brief. */
export async function getDeliverable(id: number): Promise<DeliverableDetail | null> {
  const d = await queryOne<DeliverableDetail>(
    `SELECT d.id, d.client_id, d.title, d.description, d.content_hook, d.platform,
            d.video_type, d.promotion_type, d.language, d.target_audience,
            d.custom_instructions, d.ai_prompt, d.month_key, d.status, d.priority,
            d.due_date, d.caption, d.edited_link, d.raw_drive_link, d.reject_reason,
            d.ai_score, d.service, d.content_category, d.assigned_to, d.created_at,
            c.company_name, c.business_type, c.contact_person, c.phone, c.email,
            c.website, c.company_logo_url, c.instagram_link, c.facebook_link,
            c.youtube_link, c.caption_settings, c.placeholder_values
     FROM deliverables d JOIN clients c ON c.id = d.client_id
     WHERE d.id = ?`,
    [id]
  );
  if (!d) return null;
  return { ...d, ai_score: d.ai_score == null ? null : n(d.ai_score) };
}

export type ApprovalCounts = {
  content: number;
  final: number;
  changes: number;
  approved: number;
};

/** Counts for the Approvals worklist tabs (churned clients excluded). */
export async function getApprovalCounts(crmClientIds?: number[] | null): Promise<ApprovalCounts> {
  if (crmClientIds && crmClientIds.length === 0) {
    return { content: 0, final: 0, changes: 0, approved: 0 };
  }
  const scope =
    crmClientIds && crmClientIds.length
      ? `AND d.client_id IN (${crmClientIds.map(() => "?").join(",")})`
      : "";
  const row = await queryOne<Record<string, unknown>>(
    `SELECT
       COALESCE(SUM(d.status = 'content_review'),0)     AS content,
       COALESCE(SUM(d.status = 'review'),0)             AS final,
       COALESCE(SUM(d.status = 'changes_requested'),0)  AS changes,
       COALESCE(SUM(d.status = 'approved'),0)           AS approved
     FROM deliverables d JOIN clients c ON c.id = d.client_id
     WHERE c.status != 'churned' ${scope}`,
    crmClientIds && crmClientIds.length ? crmClientIds : []
  );
  return {
    content: n(row?.content),
    final: n(row?.final),
    changes: n(row?.changes),
    approved: n(row?.approved),
  };
}

export type ClientMini = { id: number; company_name: string };

/** Active/non-churned clients for dropdowns. */
export async function getClientsMini(crmClientIds?: number[] | null): Promise<ClientMini[]> {
  if (crmClientIds && crmClientIds.length === 0) return [];
  const scope =
    crmClientIds && crmClientIds.length ? `AND id IN (${crmClientIds.map(() => "?").join(",")})` : "";
  return query<ClientMini>(
    `SELECT id, company_name FROM clients WHERE status != 'churned' ${scope} ORDER BY company_name`,
    crmClientIds && crmClientIds.length ? crmClientIds : []
  );
}
