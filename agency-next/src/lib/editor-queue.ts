/**
 * The video editor's worklist.
 *
 * A different question from the one `/deliverables` answers. That page is the
 * whole catalogue, filtered every which way; this one answers "what am I
 * editing today, and what is stuck waiting on me" — so it is organised by the
 * editing pipeline rather than by client or date.
 */
import "server-only";
import { query, queryOne, hasColumn } from "./db";
import { buildVideoPermalink } from "./video-link";

/** The stages a video passes through while an editor owns it. */
export const EDITOR_STAGES = [
  { key: "waiting_for_raw", label: "Waiting for footage", hint: "The client hasn't sent raw video yet" },
  { key: "raw_uploaded", label: "Ready to edit", hint: "Footage is in — start editing" },
  { key: "editing", label: "Being edited", hint: "In progress" },
  { key: "caption_ready", label: "Needs review", hint: "Edited, waiting to go to the client" },
  { key: "changes_requested", label: "Changes requested", hint: "The client asked for edits" },
] as const;

export type EditorStage = (typeof EDITOR_STAGES)[number]["key"];

export type EditorTask = {
  id: number;
  title: string;
  status: string;
  priority: string;
  due_date: string | null;
  company_name: string;
  client_id: number;
  assigned_to: number | null;
  assignee_name: string | null;
  content_category: string | null;
  video_type: string | null;
  cloud_video_key: string | null;
  cloud_video_url: string | null;
  edited_link: string | null;
  raw_drive_link: string | null;
  reject_reason: string | null;
  caption: string | null;
  /** Derived — a permanent link that works with a private bucket. */
  video_link: string | null;
  /** Null when the AI has never looked at this one. */
  ai_state: string | null;
  ai_caption: string | null;
  ai_language: string | null;
};

export type EditorFilters = {
  /** Restrict to one editor. Omit for everything. */
  assignedTo?: number | null;
  stage?: EditorStage | null;
  clientId?: number | null;
  /** crm scoping: null = unrestricted, [] = nothing. */
  allowedClientIds?: number[] | null;
};

function buildWhere(f: EditorFilters): { where: string; params: (string | number)[] } {
  // Only video work — posters have their own board.
  const conds: string[] = [
    "c.status <> 'churned'",
    "(d.service = 'video_editing' OR (d.service IS NULL AND LOWER(COALESCE(d.video_type,'')) <> 'poster'))",
  ];
  const params: (string | number)[] = [];

  if (f.stage) {
    conds.push("d.status = ?");
    params.push(f.stage);
  } else {
    // The default view is "everything still on an editor's plate" — finished
    // and cancelled work would otherwise bury it.
    conds.push(`d.status IN (${EDITOR_STAGES.map(() => "?").join(",")})`);
    params.push(...EDITOR_STAGES.map((s) => s.key));
  }

  if (f.assignedTo) {
    conds.push("d.assigned_to = ?");
    params.push(f.assignedTo);
  }
  if (f.clientId) {
    conds.push("d.client_id = ?");
    params.push(f.clientId);
  }
  if (f.allowedClientIds !== undefined && f.allowedClientIds !== null) {
    if (f.allowedClientIds.length === 0) conds.push("1=0");
    else {
      conds.push(`d.client_id IN (${f.allowedClientIds.map(() => "?").join(",")})`);
      params.push(...f.allowedClientIds);
    }
  }

  return { where: `WHERE ${conds.join(" AND ")}`, params };
}

export async function getEditorQueue(f: EditorFilters = {}): Promise<EditorTask[]> {
  const { where, params } = buildWhere(f);

  // The AI columns arrive with a later migration; join only when they exist so
  // the board still renders on a database that hasn't been migrated.
  const hasAi = await hasColumn("video_analysis", "state");
  const aiSelect = hasAi
    ? "v.state AS ai_state, v.caption AS ai_caption, v.spoken_language AS ai_language"
    : "NULL AS ai_state, NULL AS ai_caption, NULL AS ai_language";
  const aiJoin = hasAi ? "LEFT JOIN video_analysis v ON v.deliverable_id = d.id" : "";

  const rows = await query<EditorTask>(
    `SELECT d.id, d.title, d.status, d.priority, d.due_date, c.company_name, d.client_id,
            d.assigned_to, u.name AS assignee_name, d.content_category, d.video_type,
            d.cloud_video_key, d.cloud_video_url, d.edited_link, d.raw_drive_link,
            d.reject_reason, d.caption, ${aiSelect}
       FROM deliverables d
       JOIN clients c ON c.id = d.client_id
       LEFT JOIN users u ON u.id = d.assigned_to
       ${aiJoin}
       ${where}
      ORDER BY FIELD(d.status,'changes_requested','raw_uploaded','editing','caption_ready','waiting_for_raw'),
               d.due_date IS NULL, d.due_date ASC,
               FIELD(d.priority,'urgent','high','medium','low'), d.id DESC
      LIMIT 200`,
    params
  );

  return rows.map((r) => ({
    ...r,
    video_link:
      r.cloud_video_url || (r.cloud_video_key ? buildVideoPermalink(r.id, r.cloud_video_key) : null),
  }));
}

export type StageCounts = Record<EditorStage | "all", number>;

/** Counts behind each stage tab, under the other active filters. */
export async function getStageCounts(f: EditorFilters = {}): Promise<StageCounts> {
  const { where, params } = buildWhere({ ...f, stage: null });

  const row = await queryOne<Record<string, unknown>>(
    `SELECT COUNT(*) AS all_count,
            ${EDITOR_STAGES.map((s) => `COALESCE(SUM(d.status = '${s.key}'),0) AS ${s.key}`).join(",\n            ")}
       FROM deliverables d JOIN clients c ON c.id = d.client_id
       ${where}`,
    params
  );

  const n = (v: unknown) => Number(v ?? 0);
  const out = { all: n(row?.all_count) } as StageCounts;
  for (const s of EDITOR_STAGES) out[s.key] = n(row?.[s.key]);
  return out;
}

export type EditorOption = { id: number; name: string; role: string };

/** Staff who can be assigned video work. */
export async function getEditors(): Promise<EditorOption[]> {
  return query<EditorOption>(
    `SELECT id, name, role FROM users
      WHERE role IN ('super_admin','admin','poster_designer') AND is_active = 1
      ORDER BY name`
  );
}
