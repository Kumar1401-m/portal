/**
 * The Insights Center — what the Brain has to say, before anybody asks it.
 *
 * The Brain answers a question about one client. Nobody has time to ask it
 * twenty questions every morning, and the findings that matter most are the
 * ones nobody thought to look for. So this runs the same analysis across every
 * client on the floor and keeps the results, ranked.
 *
 * Stored in `ai_insights`, which was already in the schema and unread — one
 * row per client per kind, so a finding that is still true is updated rather
 * than duplicated, and a client's board does not fill up with a fortnight of
 * the same warning.
 *
 * **A finding that has stopped being true is deleted.** That is the part that
 * makes an alerts screen worth opening: the reach recovered, the approval came
 * back, the invoice was paid, and the alert goes away by itself. An insights
 * page nobody can clear is a page nobody reads.
 */
import "server-only";
import { query, execute, hasTable } from "./db";
import { onTheFloor } from "./client-status";
import { gatherEvidence, findings, health, type Finding, type Severity } from "./brain";
import { thisMonthKey } from "./date-range";

export const insightsReady = () => hasTable("ai_insights");

export type StoredInsight = Finding & {
  clientId: number;
  client: string;
  generatedAt: string;
};

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  warning: 1,
  opportunity: 2,
  good: 3,
};

/**
 * Re-run the analysis and store what it found.
 *
 * Whole-agency by default. Per-client evidence is several queries, so this is
 * a job rather than something a page render triggers — a dashboard that
 * recomputed every client's two-month history on every visit would be slow in
 * exactly the way that gets a feature switched off.
 */
export async function refreshInsights(
  clientIds?: number[]
): Promise<{ clients: number; found: number; cleared: number }> {
  if (!(await insightsReady())) return { clients: 0, found: 0, cleared: 0 };

  const scope =
    clientIds && clientIds.length
      ? await query<{ id: number }>(
          `SELECT id FROM clients c WHERE ${onTheFloor()} AND id IN (${clientIds.map(() => "?").join(",")})`,
          clientIds
        )
      : await query<{ id: number }>(
          `SELECT id FROM clients c WHERE ${onTheFloor()} AND COALESCE(is_personal,0) = 0`
        );

  const month = thisMonthKey();
  const [y, m] = month.split("-").map(Number);
  const periodStart = `${month}-01`;
  const periodEnd = `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;

  let found = 0;
  let cleared = 0;

  for (const { id } of scope) {
    const evidence = await gatherEvidence(id, month).catch(() => null);
    if (!evidence) continue;

    const list = findings(evidence);
    found += list.length;

    for (const f of list) {
      await execute(
        `INSERT INTO ai_insights
           (client_id, platform, kind, headline, detail, confidence, evidence_json, period_start, period_end, generated_at)
         VALUES (?, 'instagram', ?, ?, ?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE
           headline = VALUES(headline), detail = VALUES(detail),
           confidence = VALUES(confidence), evidence_json = VALUES(evidence_json),
           period_start = VALUES(period_start), period_end = VALUES(period_end),
           generated_at = NOW()`,
        [
          id,
          f.kind.slice(0, 40),
          f.headline.slice(0, 255),
          f.reason,
          // The column is DECIMAL(4,2) — 95 fits, and confidence never exceeds it.
          f.confidence,
          JSON.stringify({
            severity: f.severity,
            evidence: f.evidence,
            recommendation: f.recommendation,
            action: f.action ?? null,
          }),
          periodStart,
          periodEnd,
        ]
      ).catch(() => undefined);
    }

    /*
     * Anything this client had that the run did not produce again has stopped
     * being true. Deleted rather than left with an old timestamp, because an
     * alert nobody can clear is the reason alert screens get ignored.
     */
    const kinds = list.map((f) => f.kind);
    const res = await execute(
      kinds.length
        ? `DELETE FROM ai_insights WHERE client_id = ? AND kind NOT IN (${kinds.map(() => "?").join(",")})`
        : "DELETE FROM ai_insights WHERE client_id = ?",
      [id, ...kinds]
    ).catch(() => null);
    cleared += res?.affectedRows ?? 0;
  }

  return { clients: scope.length, found, cleared };
}

/**
 * What is on the board now, most serious first.
 *
 * `clientIds` is the crm scope, exactly as everywhere else: null is
 * unrestricted, an empty array is a user assigned nobody and must see nothing.
 */
export async function getInsights(clientIds?: number[] | null, limit = 40): Promise<StoredInsight[]> {
  if (!(await insightsReady())) return [];
  if (clientIds && clientIds.length === 0) return [];

  const rows = await query<Record<string, unknown>>(
    `SELECT i.*, c.company_name
       FROM ai_insights i
       JOIN clients c ON c.id = i.client_id
      WHERE ${onTheFloor()}${clientIds ? ` AND i.client_id IN (${clientIds.map(() => "?").join(",")})` : ""}
      ORDER BY i.generated_at DESC
      LIMIT ${Math.max(1, Math.trunc(limit))}`,
    clientIds ?? []
  ).catch(() => []);

  const parsed = rows.map((r): StoredInsight => {
    // MySQL's JSON column comes back parsed by the driver, but a row written
    // by anything else may still be a string — both are handled rather than
    // one of them throwing on a page nobody could then open.
    const raw = r.evidence_json;
    const extra =
      (typeof raw === "string" ? safeParse(raw) : (raw as Record<string, unknown> | null)) ?? {};
    return {
      clientId: Number(r.client_id),
      client: String(r.company_name),
      kind: String(r.kind),
      severity: (String(extra.severity ?? "warning") as Severity) ?? "warning",
      headline: String(r.headline ?? ""),
      reason: String(r.detail ?? ""),
      evidence: Array.isArray(extra.evidence) ? (extra.evidence as string[]) : [],
      recommendation: String(extra.recommendation ?? ""),
      confidence: Math.round(Number(r.confidence ?? 0)),
      action: (extra.action as Finding["action"]) ?? undefined,
      generatedAt: String(r.generated_at ?? ""),
    };
  });

  return parsed.sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.confidence - a.confidence
  );
}

function safeParse(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export type ClientHealth = {
  clientId: number;
  client: string;
  score: number;
  band: "healthy" | "attention" | "critical";
  reasons: { label: string; delta: number }[];
};

/**
 * Every client's health score, worst first.
 *
 * Computed live rather than stored: it is a handful of queries per client and
 * it is read on one screen, so a stored copy would be a second version of the
 * same fact with its own staleness question.
 */
export async function healthBoard(clientIds?: number[] | null): Promise<ClientHealth[]> {
  if (clientIds && clientIds.length === 0) return [];

  const clients = await query<{ id: number; company_name: string }>(
    `SELECT id, company_name FROM clients c
      WHERE ${onTheFloor()} AND COALESCE(is_personal,0) = 0
      ${clientIds ? `AND id IN (${clientIds.map(() => "?").join(",")})` : ""}
      ORDER BY company_name`,
    clientIds ?? []
  );

  const out: ClientHealth[] = [];
  for (const c of clients) {
    const evidence = await gatherEvidence(c.id).catch(() => null);
    if (!evidence) continue;
    const h = health(evidence);
    out.push({ clientId: c.id, client: c.company_name, ...h });
  }
  return out.sort((a, b) => a.score - b.score);
}
