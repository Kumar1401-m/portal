"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { randomInt } from "crypto";
import bcrypt from "bcryptjs";
import { queryOne, execute, transaction, hasColumn, type ResultSetHeader } from "@/lib/db";
import { requireUser, ADMIN_ROLES, ADMIN_OR_CRM_ROLES, SUPER_ADMIN_ROLES } from "@/lib/auth";
import { env } from "@/lib/env";
import { sendOnboardingEmail } from "@/lib/email";
import { isServiceKey } from "@/lib/services";
import { setClientCrmAccess } from "@/lib/crm";

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

  /* ---- Instagram automation. Same guard: these columns arrive with the
     analytics migration, and a database that hasn't run it must still be able
     to save a client. ---- */
  if (await hasColumn("clients", "auto_publish")) {
    columns.ig_username = orNull(s(fd, "ig_username").replace(/^@/, ""));
    columns.whatsapp_number = orNull(s(fd, "whatsapp_number"));
    // Unattended posting to a live account — never inferred, only ticked.
    columns.auto_publish = fd.get("auto_publish") ? 1 : 0;
    columns.analytics_enabled = fd.get("analytics_enabled") ? 1 : 0;

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

  revalidatePath("/clients");
  redirect(`/clients/${clientId}`);
}

/* ------------------------------- Update ------------------------------- */

export async function updateClient(formData: FormData): Promise<void> {
  const user = await requireUser(ADMIN_ROLES);
  const isSuperAdmin = user.role === "super_admin";
  const id = Number(formData.get("id"));
  if (!id) redirect("/clients");

  const existing = await queryOne<{
    id: number;
    designer_id: number | null;
    caption_settings: unknown;
    placeholder_values: unknown;
  }>("SELECT id, designer_id, caption_settings, placeholder_values FROM clients WHERE id = ?", [id]);
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

  // Designer changed at client level → reassign this client's open tasks.
  if (existing!.designer_id !== columns.designer_id) {
    await execute(
      `UPDATE deliverables SET assigned_to = ?
       WHERE client_id = ? AND status NOT IN ('posted','completed','cancelled','rejected')`,
      [columns.designer_id, id]
    );
  }

  if (isSuperAdmin) {
    const crmUserIds = formData
      .getAll("crm_user_ids")
      .map(Number)
      .filter((n) => Number.isFinite(n) && n > 0);
    await setClientCrmAccess(id, crmUserIds);
  }

  await normalizeInstagramId(id, columns.ig_user_id);

  revalidatePath(`/clients/${id}`);
  revalidatePath("/clients");
  redirect(`/clients/${id}`);
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
    const { resolveInstagramAccount } = await import("@/lib/instagram-sync");
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
  revalidatePath("/clients");
  redirect("/clients");
}
