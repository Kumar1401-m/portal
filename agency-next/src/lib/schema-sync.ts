/**
 * Applying the additive parts of the schema from inside the portal.
 *
 * The app degrades gracefully when a column it wants isn't there yet (see
 * `hasColumn`), which keeps a deploy safe but leaves the feature quietly
 * switched off until someone runs `database/migrate.js`. On a hosted database
 * with no shell to hand, that "someone" never gets round to it and a column
 * stays missing for weeks.
 *
 * So the super admin can apply them from Settings. Deliberately narrow:
 *
 *   - only the statements written out below, never anything from a request
 *   - only ADD COLUMN, so nothing existing can be altered or dropped
 *   - skipped when the column is already there, so it's safe to run twice
 *
 * `database/migrate.js` remains the source of truth and does the same work;
 * this is the same list reachable without a terminal.
 */
import "server-only";
import { query, executeDdl, forgetColumn } from "./db";

type ColumnSpec = {
  table: string;
  column: string;
  /** The full column definition, exactly as migrate.js writes it. */
  definition: string;
  /** What the column is for, shown in Settings. */
  purpose: string;
};

const EXPECTED: ColumnSpec[] = [
  {
    table: "clients",
    column: "is_personal",
    definition: "is_personal TINYINT(1) NOT NULL DEFAULT 0",
    purpose: "Marks a client as the agency's own, so it can be kept out of reports.",
  },
  {
    table: "clients",
    column: "monthly_posters",
    definition: "monthly_posters INT UNSIGNED NOT NULL DEFAULT 0",
    purpose: "Monthly poster target, counted separately from videos.",
  },
  {
    table: "clients",
    column: "category",
    definition: "category VARCHAR(10) NOT NULL DEFAULT ''",
    purpose: "The A / B / C tier shown in the Category column of the monthly report.",
  },
  {
    table: "deliverables",
    column: "reference_links",
    definition: "reference_links TEXT DEFAULT NULL",
    purpose: "Reference links, for when a client sends no raw footage.",
  },
  {
    table: "deliverables",
    column: "cloud_video_url",
    definition: "cloud_video_url VARCHAR(600) DEFAULT NULL",
    purpose: "Public URL of an uploaded video, when the bucket has one.",
  },
  {
    table: "deliverables",
    column: "cloud_video_key",
    definition: "cloud_video_key VARCHAR(400) DEFAULT NULL",
    purpose: "Object key of an uploaded video — what signed links are built from.",
  },
];

export type SchemaColumnStatus = ColumnSpec & { present: boolean };

/**
 * One information_schema round trip for the whole list.
 *
 * The columns are aliased and lowercased in SQL rather than in JS: MySQL
 * returns information_schema names in upper case, so reading `row.table_name`
 * gives undefined and every column looks missing — which then tries to add
 * columns that are already there.
 */
export async function schemaStatus(): Promise<SchemaColumnStatus[]> {
  const rows = await query<{ t: string; c: string }>(
    `SELECT LOWER(TABLE_NAME) AS t, LOWER(COLUMN_NAME) AS c
       FROM information_schema.columns
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME IN ('clients','deliverables')`
  );
  const have = new Set(rows.map((r) => `${r.t}.${r.c}`));
  return EXPECTED.map((c) => ({
    ...c,
    present: have.has(`${c.table}.${c.column}`.toLowerCase()),
  }));
}

export type ApplyResult = {
  added: string[];
  failed: { column: string; error: string }[];
};

/**
 * Add whatever is missing. Each column is attempted on its own so one failure
 * doesn't strand the rest, and `hasColumn`'s cache is cleared for anything
 * added — otherwise this process would keep believing the column is absent
 * until it restarts.
 */
export async function applyPendingColumns(): Promise<ApplyResult> {
  const status = await schemaStatus();
  const added: string[] = [];
  const failed: { column: string; error: string }[] = [];

  for (const c of status) {
    if (c.present) continue;
    try {
      // `definition` is a literal from the list above, never from input.
      await executeDdl(`ALTER TABLE \`${c.table}\` ADD COLUMN ${c.definition}`);
      forgetColumn(c.table, c.column);
      added.push(`${c.table}.${c.column}`);
    } catch (e) {
      failed.push({
        column: `${c.table}.${c.column}`,
        error: e instanceof Error ? e.message : "Unknown error",
      });
    }
  }
  return { added, failed };
}
