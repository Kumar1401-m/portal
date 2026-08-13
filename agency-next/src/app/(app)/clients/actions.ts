"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { randomInt } from "crypto";
import bcrypt from "bcryptjs";
import { queryOne, execute, transaction, hasColumn, type ResultSetHeader } from "@/lib/db";
import { requireUser, ADMIN_ROLES, ADMIN_OR_CRM_ROLES, SUPER_ADMIN_ROLES } from "@/lib/auth";
import { env } from "@/lib/env";
import { sendOnboardingEmail } from "@/lib/email";
import { isServiceKey, type ServiceKey } from "@/lib/services";
import { setClientCrmAccess } from "@/lib/crm";
import { generateMonthTasks, syncMonthToTarget } from "@/lib/task-plan";
import { monthKey } from "@/lib/utils";
import { clearClientVideoData } from "@/lib/clear-video-data";
import { normaliseAccountId } from "@/lib/ads";

const PAYMENT_PLANS = ["monthly", "quarterly", "half_yearly", "yearly", "one_time"];
const STATUSES = ["active", "inactive", "paused", "churned"];

type ClientData = {
  columns: Record<string, string | number | null>;
  captionSettings: Record<string, string>;
  placeholderValues: Record<string, string>;
};

const s = (fd: FormData, k: string) => String(fd.get(k) || "").trim();
const orNull = (v: string) => (v === "" ? null : v);

/** Extract scalar client columns + localization JSON from a form.
 *  `is_personal` is only ever taken from the form for super_admin — a plain
 *  admin's submission silently leaves it untouched, matching the UI (which
 *  doesn't even render that field for them). */
async function parseClient(fd: FormData, isSuperAdmin: boolean): Promise<ClientData> {
  const payment_plan = s(fd, "payment_plan");
  const status = s(fd, "status");
  const designer = s(fd, "designer_id");
  const editor = s(fd, "editor_id");

  const columns: Record<string, string | number | null> = {
    company_name: s(fd, "company_name"),
    contact_person: orNull(s(fd, "contact_person")),
    phone: orNull(s(fd, "phone")),
    email: orNull(s(fd, "email")),
    business_type: orNull(s(fd, "business_type")),
    website: orNull(s(fd, "website")),
    instagram_link: orNull(s(fd, "instagram_link")),
    facebook_link: orNull(s(fd, "facebook_link")),
    youtube_link: orNull(s(fd, "youtube_link")),
    monthly_package: orNull(s(fd, "monthly_package")),
    package_amount: Number(s(fd, "package_amount") || 0),
    monthly_deliverables: Number(s(fd, "monthly_deliverables") || 0),
    monthly_posters: Number(s(fd, "monthly_posters") || 0),
    payment_plan: PAYMENT_PLANS.includes(payment_plan) ? payment_plan : "monthly",
    status: STATUSES.includes(status) ? status : "active",
    joining_date: orNull(s(fd, "joining_date")),
    renewal_date: orNull(s(fd, "renewal_date")),
    notes: orNull(s(fd, "notes")),
    designer_id: designer ? Number(designer) : null,
    // Signed-up services — drives filtering/reporting only, never access.
    services: JSON.stringify(fd.getAll("services").map(String).filter(isServiceKey)),
    // Meta Graph IG business account id — enables Instagram auto-posting.
    ig_user_id: orNull(s(fd, "ig_user_id")),
  };
  if (isSuperAdmin) {
    columns.is_personal = fd.get("is_personal") ? 1 : 0;
  }
  // The A / B / C tier on the monthly report. Guarded because the column
  // arrived later — an un-migrated database still saves everything else.
  if (await hasColumn("clients", "category")) {
    columns.category = s(fd, "category").toUpperCase().slice(0, 10);
  }
  // The default editor, the video half of the pair with designer_id. Same
  // guard, same reason.
  if (await hasColumn("clients", "editor_id")) {
    columns.editor_id = editor ? Number(editor) : null;
  }
  // Normalised on the way in, so "1234567890" and "act_ 1234567890" both
  // store the one form the Graph API accepts.
  if (await hasColumn("clients", "meta_ad_account_id")) {
    columns.meta_ad_account_id = normaliseAccountId(s(fd, "meta_ad_account_id"));
  }
  // Chasing money automatically is never inferred — the same rule the other
  // outward-facing switches follow.
  if (await hasColumn("clients", "auto_payment_reminders")) {
    columns.auto_payment_reminders = fd.get("auto_payment_reminders") ? 1 : 0;
  }
  // Whether the client reads the brief before the work starts. Ticked by
  // default in the form, so an unticked box here is a deliberate "no".
  if (await hasColumn("clients", "content_approval")) {
    columns.content_approval = fd.get("content_approval") ? 1 : 0;
  }
  if (await hasColumn("clients", "ads_access_token")) {
    // Blank leaves the stored token alone — the field is a password input and
    // is never populated, so treating blank as a clear would wipe it on every
    // unrelated edit. "none" clears it, the same rule the Page token follows.
    const adsToken = s(fd, "ads_access_token");
    if (adsToken) columns.ads_access_token = adsToken.toLowerCase() === "none" ? null : adsToken;
  }
  // Posting to a second live account is never inferred, only ticked — the same
  // rule auto_publish follows, and for the same reason.
  if (await hasColumn("clients", "youtube_enabled")) {
    columns.youtube_enabled = fd.get("youtube_enabled") ? 1 : 0;
    columns.youtube_channel_id = orNull(s(fd, "youtube_channel_id"));
  }

  /* ---- Instagram automation. Guarded because these columns arrive with a
     later migration, and a database that has not run it must still be able to
     save a client. ---- */
  if (await hasColumn("clients", "auto_publish")) {
    columns.ig_username = orNull(s(fd, "ig_username").replace(/^@/, ""));
    columns.whatsapp_number = orNull(s(fd, "whatsapp_number"));
    // Unattended posting to a live account — never inferred, only ticked.
    columns.auto_publish = fd.get("auto_publish") ? 1 : 0;

    // A blank token means "leave whatever is stored alone", not "clear it" —
    // the field renders as a password input and is never populated with the
    // saved value, so treating blank as a clear would wipe the token on every
    // unrelated edit. Clearing it is done by writing the word "none".
    const token = s(fd, "ig_access_token");
    if (token) columns.ig_access_token = token.toLowerCase() === "none" ? null : token;
  }

  // Localization → these drive the AI caption brief (city/country/language/tone).
  const captionSettings: Record<string, string> = {};
  if (s(fd, "caption_language")) captionSettings.language = s(fd, "caption_language");
  if (s(fd, "caption_tone")) captionSettings.tone = s(fd, "caption_tone");

  const placeholderValues: Record<string, string> = {};
  if (s(fd, "loc_city")) placeholderValues.location = s(fd, "loc_city");
  if (s(fd, "loc_country")) placeholderValues.country = s(fd, "loc_country");
  if (s(fd, "loc_whatsapp")) placeholderValues.whatsapp = s(fd, "loc_whatsapp");

  return { columns, captionSettings, placeholderValues };
}

/* ------------------------------- Create ------------------------------- */

export async function createClient(formData: FormData): Promise<void> {
  const user = await requireUser(ADMIN_OR_CRM_ROLES);
  const isSuperAdmin = user.role === "super_admin";
  const { columns, captionSettings, placeholderValues } = await parseClient(formData, isSuperAdmin);
  const portalPassword = s(formData, "portal_password");

  if (!columns.company_name || String(columns.company_name).length < 2) {
    redirect("/clients/new?error=name");
  }
  if (portalPassword && !columns.email) {
    redirect("/clients/new?error=email");
  }

  let clientId: number;
  try {
    clientId = await transaction(async (conn) => {
      let userId: number | null = null;
      if (portalPassword) {
        const hash = await bcrypt.hash(portalPassword, env.bcryptRounds);
        const [u] = await conn.execute(
          "INSERT INTO users (name, email, password_hash, role) VALUES (?,?,?,?)",
          [columns.contact_person || columns.company_name, columns.email, hash, "client"]
        );
        userId = (u as ResultSetHeader).insertId;
      }
      const cols = Object.keys(columns);
      const [c] = await conn.execute(
        `INSERT INTO clients (${cols.join(",")}, caption_settings, placeholder_values, user_id, created_by)
         VALUES (${cols.map(() => "?").join(",")},?,?,?,?)`,
        [
          ...cols.map((k) => columns[k]),
          JSON.stringify(captionSettings),
          JSON.stringify(placeholderValues),
          userId,
          user.id,
        ]
      );
      return (c as ResultSetHeader).insertId;
    });
  } catch (e) {
    const msg = e instanceof Error && /duplicate/i.test(e.message) ? "dupemail" : "failed";
    redirect(`/clients/new?error=${msg}`);
  }

  if (isSuperAdmin) {
    const crmUserIds = formData
      .getAll("crm_user_ids")
      .map(Number)
      .filter((n) => Number.isFinite(n) && n > 0);
    await setClientCrmAccess(clientId, crmUserIds);
  } else if (user.role === "crm") {
    // A crm who onboards a client keeps access to it; the super admin can
    // still reassign or revoke that later from the client's own page.
    await setClientCrmAccess(clientId, [user.id]);
  }

  // Formal onboarding email (best-effort; includes creds when a login was made).
  if (columns.email) {
    sendOnboardingEmail(
      {
        company_name: String(columns.company_name),
        contact_person: columns.contact_person ? String(columns.contact_person) : null,
        email: String(columns.email),
      },
      { password: portalPassword || null }
    ).catch(() => {});
  }

  await normalizeInstagramId(clientId, columns.ig_user_id);

  // The month's work, from the numbers just entered. Best-effort: a client who
  // is saved but whose tasks failed to generate is a nuisance you can fix with
  // the button on their page, while losing the whole client record over it is
  // not. Nothing is generated when both counts are zero.
  try {
    await generateMonthTasks(clientId, monthKey(), user.id);
    revalidatePath("/deliverables");
  } catch (err) {
    console.warn("could not generate the first month's tasks:", err instanceof Error ? err.message : err);
  }

  revalidatePath("/clients");
  redirect(`/clients/${clientId}`);
}

/* ------------------------------- Update ------------------------------- */

export async function updateClient(formData: FormData): Promise<void> {
  const user = await requireUser(ADMIN_ROLES);
  const isSuperAdmin = user.role === "super_admin";
  const id = Number(formData.get("id"));
  if (!id) redirect("/clients");

  const hasEditorCol = await hasColumn("clients", "editor_id");
  const existing = await queryOne<{
    id: number;
    designer_id: number | null;
    editor_id: number | null;
    caption_settings: unknown;
    placeholder_values: unknown;
    monthly_deliverables: number | null;
    monthly_posters: number | null;
  }>(
    `SELECT id, designer_id, ${hasEditorCol ? "editor_id" : "NULL AS editor_id"},
            caption_settings, placeholder_values,
            monthly_deliverables, monthly_posters
       FROM clients WHERE id = ?`,
    [id]
  );
  if (!existing) redirect("/clients");

  const { columns, captionSettings, placeholderValues } = await parseClient(formData, isSuperAdmin);
  if (!columns.company_name || String(columns.company_name).length < 2) {
    redirect(`/clients/${id}/edit?error=name`);
  }

  // Merge localization into existing JSON so other keys are preserved.
  const asObj = (v: unknown): Record<string, unknown> =>
    v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const mergedCs = { ...asObj(existing!.caption_settings), ...captionSettings };
  const mergedPh = { ...asObj(existing!.placeholder_values), ...placeholderValues };

  const cols = Object.keys(columns);
  await execute(
    `UPDATE clients SET ${cols.map((k) => `${k} = ?`).join(", ")},
       caption_settings = ?, placeholder_values = ? WHERE id = ?`,
    [...cols.map((k) => columns[k]), JSON.stringify(mergedCs), JSON.stringify(mergedPh), id]
  );

  /*
   * A default changed → move this client's open work to the new person.
   *
   * Only the work that default is *for*. This used to reassign every open task
   * of the client, so picking a poster designer handed them the videos as
   * well — the create and generate paths were fixed to split by service and
   * this one was not, which meant the same choice did different things
   * depending on where it was made.
   *
   * Finished work keeps the name of whoever actually did it.
   */
  const OPEN = "status NOT IN ('posted','completed','cancelled','rejected')";
  const reassign = async (service: ServiceKey, to: unknown) =>
    execute(
      `UPDATE deliverables SET assigned_to = ? WHERE client_id = ? AND service = ? AND ${OPEN}`,
      [to as number | null, id, service]
    );
  if (existing!.designer_id !== columns.designer_id) {
    await reassign("poster_designing", columns.designer_id);
  }
  if ("editor_id" in columns && existing!.editor_id !== columns.editor_id) {
    await reassign("video_editing", columns.editor_id);
  }

  if (isSuperAdmin) {
    const crmUserIds = formData
      .getAll("crm_user_ids")
      .map(Number)
      .filter((n) => Number.isFinite(n) && n > 0);
    await setClientCrmAccess(id, crmUserIds);
  }

  await normalizeInstagramId(id, columns.ig_user_id);

  /*
   * A changed contract changes this month's work, now.
   *
   * The number on the client record is what the month owes, so moving it and
   * leaving the task list alone made the two disagree until somebody
   * remembered to press Generate — and going down had no button at all, so a
   * client cut from twenty to twelve kept twenty tasks and every count
   * downstream measured against a contract that no longer existed.
   *
   * Only when the numbers actually moved: editing a phone number should not
   * touch anybody's tasks. Only untouched placeholders are ever removed, so a
   * reduction cannot destroy work that has been started.
   */
  let synced = "";
  const targetsChanged =
    Number(existing!.monthly_deliverables ?? 0) !== Number(columns.monthly_deliverables) ||
    Number(existing!.monthly_posters ?? 0) !== Number(columns.monthly_posters);

  if (targetsChanged && columns.status !== "churned") {
    try {
      const r = await syncMonthToTarget(id, monthKey(), user.id);
      const added = r.added.videos + r.added.posters;
      const removed = r.removed.videos + r.removed.posters;
      const parts = [
        added ? `${added} added` : null,
        removed ? `${removed} removed` : null,
        r.blocked ? `${r.blocked} kept (already started)` : null,
      ].filter(Boolean);
      if (parts.length) synced = parts.join(", ");
    } catch (err) {
      // The client's details are saved either way; a failed top-up is a thing
      // to retry from the plan, not a reason to lose the edit.
      console.warn("[clients] could not sync the month to the new target:", err instanceof Error ? err.message : err);
    }
  }

  revalidatePath(`/clients/${id}`);
  revalidatePath("/clients");
  revalidatePath("/dashboard");
  revalidatePath("/deliverables");
  revalidatePath("/today");
  redirect(synced ? `/clients/${id}?synced=${encodeURIComponent(synced)}` : `/clients/${id}`);
}

/**
 * Translate a pasted Facebook Page id into the Instagram Business account id.
 *
 * People paste the Page id here constantly — it's the number Meta's own UI
 * shows most prominently and the two look identical. Stored unchanged, it
 * fails at publish time with `(#100) Tried accessing nonexisting field
 * (media)`, which names neither the problem nor the fix, and which nobody
 * sees until a post silently doesn't go out.
 *
 * Correcting it on save turns a confusing runtime failure into no failure at
 * all. Deliberately best-effort: a Meta outage, an expired token or no token
 * configured must never stop someone saving a client, so anything that goes
 * wrong here leaves the value exactly as typed.
 */
async function normalizeInstagramId(clientId: number, pasted: unknown): Promise<void> {
  const id = typeof pasted === "string" ? pasted.trim() : "";
  if (!id) return;

  try {
    const { resolveInstagramAccount } = await import("@/lib/instagram");
    const { env } = await import("@/lib/env");

    const row = await queryOne<{ ig_access_token: string | null }>(
      "SELECT ig_access_token FROM clients WHERE id = ?",
      [clientId]
    );
    const token = row?.ig_access_token || env.meta.accessToken;
    if (!token) return; // nothing to check against — keep what was typed

    const resolved = await resolveInstagramAccount(id, token);
    if (!resolved.ok) return;

    const { igUserId, username } = resolved.account;
    if (igUserId && igUserId !== id) {
      await execute("UPDATE clients SET ig_user_id = ? WHERE id = ?", [igUserId, clientId]);
    }
    if (username && (await hasColumn("clients", "ig_username"))) {
      await execute("UPDATE clients SET ig_username = ? WHERE id = ?", [username, clientId]);
    }
  } catch (err) {
    console.warn(
      "[clients] Instagram id check skipped:",
      err instanceof Error ? err.message : err
    );
  }
}

/* --------------------------- Portal login --------------------------- */

export type PortalState = { ok: boolean; error?: string };

export async function setPortalLogin(
  _prev: PortalState,
  formData: FormData
): Promise<PortalState> {
  await requireUser(ADMIN_ROLES);
  const id = Number(formData.get("id"));
  const password = String(formData.get("password") || "");
  if (!id) return { ok: false, error: "Missing client." };
  if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    return { ok: false, error: "Min 8 characters with letters and numbers." };
  }
  const client = await queryOne<{ user_id: number | null; email: string | null; company_name: string; contact_person: string | null }>(
    "SELECT user_id, email, company_name, contact_person FROM clients WHERE id = ?",
    [id]
  );
  if (!client) return { ok: false, error: "Client not found." };
  if (!client.email) return { ok: false, error: "Set the client's email first." };

  const hash = await bcrypt.hash(password, env.bcryptRounds);
  try {
    if (client.user_id) {
      await execute("UPDATE users SET password_hash = ?, is_active = 1 WHERE id = ?", [hash, client.user_id]);
      await execute("UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ?", [client.user_id]);
    } else {
      const u = await execute("INSERT INTO users (name, email, password_hash, role) VALUES (?,?,?,?)", [
        client.contact_person || client.company_name,
        client.email,
        hash,
        "client",
      ]);
      await execute("UPDATE clients SET user_id = ? WHERE id = ?", [u.insertId, id]);
    }
  } catch (e) {
    return { ok: false, error: /duplicate/i.test(String(e)) ? "That email already has a login." : "Failed." };
  }
  revalidatePath(`/clients/${id}`);
  return { ok: true };
}

/* ------------------------- Resend onboarding email ------------------------- */

/** A-Z/a-z minus ambiguous glyphs (0/O, 1/l/I) so a printed/read-aloud password isn't confusing. */
const PASSWORD_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const PASSWORD_DIGITS = "23456789";

function generatePortalPassword(): string {
  const pick = (charset: string) => charset[randomInt(charset.length)];
  const chars = [pick(PASSWORD_DIGITS), pick(PASSWORD_DIGITS), ...Array.from({ length: 8 }, () => pick(PASSWORD_LETTERS))];
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

export type ResendState = { ok: boolean; error?: string; message?: string };

/**
 * Re-send the onboarding email — for when the address was wrong the first
 * time (typo, etc.) and got corrected via Edit. If a portal login already
 * exists, this issues a FRESH password rather than resending the old one:
 * only the bcrypt hash is stored, so the original plaintext can't be
 * recovered — and if the first email went to the wrong inbox, the old
 * password may already be compromised, so rotating it here is the safe
 * default, not just a technical workaround.
 */
export async function resendOnboardingEmail(
  _prev: ResendState,
  formData: FormData
): Promise<ResendState> {
  await requireUser(ADMIN_ROLES);
  const id = Number(formData.get("id"));
  if (!id) return { ok: false, error: "Missing client." };

  const client = await queryOne<{
    id: number;
    user_id: number | null;
    email: string | null;
    company_name: string;
    contact_person: string | null;
  }>("SELECT id, user_id, email, company_name, contact_person FROM clients WHERE id = ?", [id]);
  if (!client) return { ok: false, error: "Client not found." };
  if (!client.email) return { ok: false, error: "Set the client's email first." };

  let password: string | null = null;
  if (client.user_id) {
    password = generatePortalPassword();
    const hash = await bcrypt.hash(password, env.bcryptRounds);
    await execute("UPDATE users SET password_hash = ?, is_active = 1 WHERE id = ?", [hash, client.user_id]);
    await execute("UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ?", [client.user_id]);
  }

  const sent = await sendOnboardingEmail(
    { company_name: client.company_name, contact_person: client.contact_person, email: client.email },
    { password }
  );
  if (!sent) {
    return { ok: false, error: "Email could not be sent — check SMTP settings in Settings." };
  }

  revalidatePath(`/clients/${id}`);
  return {
    ok: true,
    message: password
      ? "Onboarding email sent with a new portal password."
      : "Onboarding email sent.",
  };
}

/* ------------------------------- Archive ------------------------------- */

export async function archiveClient(formData: FormData): Promise<void> {
  await requireUser(SUPER_ADMIN_ROLES);
  const id = Number(formData.get("id"));
  if (!id) redirect("/clients");
  const client = await queryOne<{ user_id: number | null }>(
    "SELECT user_id FROM clients WHERE id = ?",
    [id]
  );
  await execute("UPDATE clients SET status = 'churned' WHERE id = ?", [id]);
  if (client?.user_id) {
    await execute("UPDATE users SET is_active = 0 WHERE id = ?", [client.user_id]);
  }

  /*
   * Their content goes with them.
   *
   * Asked for explicitly, and it is irreversible, so what it does not touch
   * is worth stating: invoices, payments and the client record itself all
   * survive. An archived client who still owes money must still owe it, and
   * the history of what they were charged has to stay readable.
   *
   * What goes is the work — videos, captions, approvals, the WhatsApp
   * transcript about them, and the video files in storage, which otherwise
   * cost money for ever with nothing left pointing at them.
   *
   * Best-effort: a client who is archived but whose videos failed to delete
   * is a tidy-up job, while failing the archive itself leaves them active and
   * still being messaged by every reminder.
   */
  try {
    const cleared = await clearClientVideoData(id);
    if (cleared.videos) {
      console.info(
        `[clients] archived ${id}: removed ${cleared.videos} videos, ${cleared.filesDeleted} files`
      );
    }
  } catch (err) {
    console.warn("[clients] could not remove the archived client's videos:", err instanceof Error ? err.message : err);
  }

  for (const p of ["/clients", "/deliverables", "/today", "/dashboard", "/approvals"]) {
    revalidatePath(p);
  }
  redirect("/clients");
}
