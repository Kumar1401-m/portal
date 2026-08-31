/**
 * What a client is sent at all.
 *
 * A different question from [[whatsapp-groups]], which answers *which of their
 * groups* a message goes to. This one answers whether it is sent — and it is
 * the question a client actually raises, because what they say is "you send me
 * too much", never "you send it to the wrong chat".
 *
 * Six kinds, named the way somebody would say them out loud. Three of the
 * switches already existed and are reused rather than duplicated: a second
 * column meaning the same thing as `auto_reminders` is how a client ends up
 * chased on a screen that says they are not.
 *
 * ## Off is off
 *
 * Unlike the group tickboxes — which *order* groups and always fall back, so a
 * misconfiguration can never silence a client — these genuinely stop the
 * message. That is the whole point of them and it is the risk: untick
 * Approvals and nobody chases that client's approvals, quietly and for ever.
 * So the screen says plainly what each one turns off, and the defaults are the
 * behaviour that existed before any of this.
 */
import "server-only";
import { hasColumn, queryOne } from "./db";

export const MESSAGE_KINDS = [
  {
    key: "approvals",
    column: "auto_reminders",
    label: "Approvals",
    blurb: "Chasing a video or poster that is waiting on them, and the month's plan.",
    /** What the column means when it has never been set. */
    fallback: true,
  },
  {
    key: "footage",
    column: "provides_footage",
    label: "Footage",
    blurb: "Asking for raw footage before a shoot. Off for clients we film ourselves.",
    fallback: true,
  },
  {
    key: "payments",
    column: "auto_payment_reminders",
    label: "Payments",
    blurb: "The weekly reminder about an invoice that is past its due date.",
    // Chasing money automatically is a decision somebody has to take per
    // client. It has been off-unless-chosen since it was built.
    fallback: false,
  },
  {
    key: "reports",
    column: "send_reports",
    label: "Monthly report",
    blurb: "The month's numbers, once, at the start of the next one.",
    fallback: true,
  },
  {
    key: "posted",
    column: "send_posted_links",
    label: "Post is live",
    blurb: "A link the moment their reel or poster goes out.",
    fallback: true,
  },
  {
    key: "ai_replies",
    column: "ai_replies",
    label: "Assistant replies",
    blurb: "Whether the assistant answers ordinary messages in their group.",
    fallback: true,
  },
] as const;

export type MessageKind = (typeof MESSAGE_KINDS)[number]["key"];

const spec = (kind: MessageKind) => MESSAGE_KINDS.find((k) => k.key === kind)!;

/**
 * Does this client get this kind of message?
 *
 * A column that has not been applied yet answers with the kind's fallback,
 * which is the behaviour that existed before the column did. So a database
 * mid-migration behaves exactly as it did yesterday rather than going quiet.
 *
 * Every failure reads as the fallback too. A database hiccup must not be the
 * reason a client stops being told their post went live.
 */
export async function clientWants(
  clientId: number | null | undefined,
  kind: MessageKind
): Promise<boolean> {
  const k = spec(kind);
  if (!clientId) return k.fallback;
  if (!(await hasColumn("clients", k.column).catch(() => false))) return k.fallback;

  const row = await queryOne<{ on: number | null }>(
    `SELECT ${k.column} AS \`on\` FROM clients WHERE id = ?`,
    [Math.trunc(Number(clientId))]
  ).catch(() => null);

  if (!row || row.on === null || row.on === undefined) return k.fallback;
  return Number(row.on) === 1;
}

/**
 * Which switches this database can actually store.
 *
 * A column that has not been applied is not a switch — it is a checkbox that
 * springs back the moment it is saved, because `wantsFrom` quite correctly
 * falls back to "on" for a column that is not there. That looked exactly like
 * a broken save, and it was reported as one.
 *
 * So the screen asks first and says so, rather than offering a control that
 * cannot work.
 */
export async function storableKinds(): Promise<MessageKind[]> {
  const out: MessageKind[] = [];
  for (const k of MESSAGE_KINDS) {
    if (await hasColumn("clients", k.column).catch(() => false)) out.push(k.key);
  }
  return out;
}

/**
 * Read the ticks straight off a client row.
 *
 * Pure, and takes the row, so the client's own page needs no extra query per
 * checkbox. Same fallback rule as above.
 */
export function wantsFrom(row: Record<string, unknown>): MessageKind[] {
  return MESSAGE_KINDS.filter((k) => {
    const v = row[k.column];
    if (v === undefined || v === null) return k.fallback;
    return Number(v) === 1;
  }).map((k) => k.key);
}
