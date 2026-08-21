/**
 * Clearing every video and everything recorded about it.
 *
 * For starting a real client list after a period of testing. Deliberately a
 * deliberate act: it removes work, approvals and the record of what a client
 * agreed to, none of which can be reconstructed.
 *
 * What it does NOT touch is as important as what it does. Clients keep their
 * records and their WhatsApp group links, users keep their logins, and
 * invoices and payments — which are financial records, not video data — are
 * left alone entirely.
 *
 * Order matters, and not only for tidiness:
 *
 *   1. Read the storage keys, because deleting the rows loses the addresses of
 *      the files they point at, and those files then cost money for ever with
 *      nothing left that knows they exist.
 *   2. Delete the rows that would otherwise be orphaned. Two tables carry a
 *      deliverable_id with no foreign key behind it, and four more are ON
 *      DELETE SET NULL, so a plain delete leaves rows pointing at nothing and
 *      rows pointing at nobody.
 *   3. Delete the deliverables, and let the cascades take the rest.
 *   4. Delete the files.
 */
import "server-only";
import { query, execute } from "./db";
import { deleteObject } from "./storage";

export type ClearSummary = {
  videos: number;
  filesDeleted: number;
  filesFailed: number;
  rows: Record<string, number>;
};

/**
 * Rows that reference a deliverable but would survive its deletion.
 *
 * The SET NULL ones are scoped to rows that actually belong to a video: a
 * script written for a video is video data, a script in the library that was
 * never attached to one is not, and clearing videos should not quietly empty
 * the library too.
 */
const ORPHANED_BY_DELETE = [
  // No foreign key at all — these would be left pointing at deleted ids.
  "whatsapp_messages",
  "whatsapp_send_log",
  // ON DELETE SET NULL — these would survive with the link blanked.
  "captions",
  "scripts",
  "thumbnails",
  "post_insights",
];

/**
 * Tables that key on the client rather than on one of their videos.
 *
 * `post_insights` is in both lists on purpose. Most of its rows point at the
 * deliverable they came from and go with it — but a post published straight
 * to the account, with no task behind it, is stored with a client and a null
 * deliverable. Clearing only by deliverable left exactly those rows, and they
 * are the ones that kept an archived client on the analytics board.
 *
 * `audience_snapshots` was never cleared at all: a follower count, per month,
 * for an account the agency no longer runs.
 */
const KEYED_BY_CLIENT = ["post_insights", "audience_snapshots"];

export async function clearAllVideoData(): Promise<ClearSummary> {
  const summary: ClearSummary = { videos: 0, filesDeleted: 0, filesFailed: 0, rows: {} };

  // 1. The addresses of the stored files, before anything is deleted.
  let keys: string[] = [];
  try {
    const rows = await query<{ cloud_video_key: string | null }>(
      "SELECT cloud_video_key FROM deliverables WHERE cloud_video_key IS NOT NULL AND cloud_video_key <> ''"
    );
    keys = rows.map((r) => r.cloud_video_key!).filter(Boolean);
  } catch {
    // An install without the storage columns simply has no files to remove.
  }

  const [{ n: total }] = await query<{ n: number }>("SELECT COUNT(*) AS n FROM deliverables");
  summary.videos = Number(total) || 0;

  // 2. Everything the cascade would miss.
  for (const table of ORPHANED_BY_DELETE) {
    try {
      const res = await execute(`DELETE FROM ${table} WHERE deliverable_id IS NOT NULL`);
      summary.rows[table] = res.affectedRows ?? 0;
    } catch {
      // A table this install never created is not a failure to report.
    }
  }

  // 3. The videos themselves. video_analysis, approvals, feedback,
  //    task_comments, publish_attempts, ai_analysis and content_versions all
  //    cascade from here.
  const deleted = await execute("DELETE FROM deliverables");
  summary.rows.deliverables = deleted.affectedRows ?? 0;

  // 4. The files. Last, and one at a time: a bucket that refuses a delete must
  //    not leave the database half-cleared, which is why this is after the
  //    rows rather than before them.
  for (const key of keys) {
    try {
      if (await deleteObject(key)) summary.filesDeleted++;
      else summary.filesFailed++;
    } catch {
      summary.filesFailed++;
    }
  }

  return summary;
}

/**
 * One client's videos and everything recorded about them.
 *
 * Same order and the same reasoning as clearing everything: read the storage
 * keys before the rows that name them, delete what the cascade would orphan,
 * then the deliverables, then the files.
 *
 * What survives is the point. Invoices and payments are financial records and
 * are never touched — an archived client who still owes money must still owe
 * it. The client row itself stays too, so the history of who they were, what
 * they were charged and what they paid remains readable.
 */
export async function clearClientVideoData(clientId: number): Promise<ClearSummary> {
  const summary: ClearSummary = { videos: 0, filesDeleted: 0, filesFailed: 0, rows: {} };
  const id = Math.trunc(Number(clientId));
  if (!id) return summary;

  let keys: string[] = [];
  try {
    const rows = await query<{ cloud_video_key: string | null }>(
      `SELECT cloud_video_key FROM deliverables
        WHERE client_id = ? AND cloud_video_key IS NOT NULL AND cloud_video_key <> ''`,
      [id]
    );
    keys = rows.map((r) => r.cloud_video_key!).filter(Boolean);
  } catch {
    /* an install without the storage columns has no files to remove */
  }

  const [{ n: total }] = await query<{ n: number }>(
    "SELECT COUNT(*) AS n FROM deliverables WHERE client_id = ?",
    [id]
  );
  summary.videos = Number(total) || 0;

  // Scoped by the deliverables this client owns, because these tables key on
  // the deliverable and not on the client — deleting by client_id here would
  // either miss rows or, worse, match another client's.
  for (const table of ORPHANED_BY_DELETE) {
    try {
      const res = await execute(
        `DELETE FROM ${table}
          WHERE deliverable_id IN (SELECT id FROM deliverables WHERE client_id = ?)`,
        [id]
      );
      summary.rows[table] = res.affectedRows ?? 0;
    } catch {
      /* a table this install never created is not a failure to report */
    }
  }

  for (const table of KEYED_BY_CLIENT) {
    try {
      const res = await execute(`DELETE FROM ${table} WHERE client_id = ?`, [id]);
      summary.rows[table] = (summary.rows[table] ?? 0) + (res.affectedRows ?? 0);
    } catch {
      /* a table this install never created is not a failure to report */
    }
  }

  const deleted = await execute("DELETE FROM deliverables WHERE client_id = ?", [id]);
  summary.rows.deliverables = deleted.affectedRows ?? 0;

  for (const key of keys) {
    try {
      if (await deleteObject(key)) summary.filesDeleted++;
      else summary.filesFailed++;
    } catch {
      summary.filesFailed++;
    }
  }

  return summary;
}

/** What the confirmation screen shows before anything is touched. */
export async function countVideoData(): Promise<{ videos: number; files: number; archived: number }> {
  const [{ n: videos }] = await query<{ n: number }>("SELECT COUNT(*) AS n FROM deliverables");
  /*
   * How many of those the boards never show.
   *
   * This counts every row, because it deletes every row. The boards exclude
   * archived clients, so the two numbers disagree and the bigger one looks
   * wrong. Naming the difference is the fix — the count is right, it is just
   * counting something the rest of the portal hides.
   */
  let archived = 0;
  try {
    const [{ n }] = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM deliverables d
         LEFT JOIN clients c ON c.id = d.client_id
        WHERE c.id IS NULL OR c.status = 'churned'`
    );
    archived = Number(n) || 0;
  } catch {
    /* leave it at zero rather than fail the panel */
  }
  let files = 0;
  try {
    const [{ n }] = await query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM deliverables WHERE cloud_video_key IS NOT NULL AND cloud_video_key <> ''"
    );
    files = Number(n) || 0;
  } catch {
    /* no storage columns on this install */
  }
  return { videos: Number(videos) || 0, files, archived };
}
