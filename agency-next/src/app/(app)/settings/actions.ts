"use server";

import { revalidatePath } from "next/cache";
import bcrypt from "bcryptjs";
import { queryOne, execute } from "@/lib/db";
import { requireUser, ADMIN_ROLES, SUPER_ADMIN_ROLES, type Role } from "@/lib/auth";
import { env } from "@/lib/env";
import { saveSettings, type Settings } from "@/lib/settings";
import { isServiceKey } from "@/lib/services";

export type ActionState = { ok: boolean; error?: string; message?: string };

const OK = (message: string): ActionState => ({ ok: true, message });
const FAIL = (error: string): ActionState => ({ ok: false, error });

const s = (fd: FormData, k: string) => String(fd.get(k) || "").trim();

/* ------------------------- Agency profile & branding ------------------------- */

export async function saveAgencyProfile(
  _prev: ActionState,
  fd: FormData
): Promise<ActionState> {
  await requireUser(ADMIN_ROLES);
  const name = s(fd, "company_name");
  if (name.length < 2) return FAIL("Enter an agency name (min 2 characters).");

  const email = s(fd, "company_email");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return FAIL("That doesn't look like a valid email address.");
  }

  const values: Partial<Settings> = {
    company_name: name,
    company_email: email,
    contact_number: s(fd, "contact_number"),
    business_address: s(fd, "business_address"),
    company_logo_url: s(fd, "company_logo_url"),
    powered_by: s(fd, "powered_by"),
  };
  await saveSettings(values);
  revalidatePath("/settings");
  return OK("Agency profile saved.");
}

/* ----------------------- Invoicing & payment gateway ----------------------- */

export async function saveBillingSettings(
  _prev: ActionState,
  fd: FormData
): Promise<ActionState> {
  await requireUser(SUPER_ADMIN_ROLES);

  const prefix = s(fd, "invoice_prefix").toUpperCase();
  if (!/^[A-Z0-9-]{1,10}$/.test(prefix)) {
    return FAIL("Invoice prefix: 1–10 letters, digits or hyphens (e.g. INV).");
  }
  const num = (k: string) => {
    const v = s(fd, k);
    return v === "" ? null : Number(v);
  };
  const tax = num("tax_percent");
  const fee = num("processing_fee_percent");
  for (const [labelText, v] of [["Tax", tax], ["Processing fee", fee]] as const) {
    if (v !== null && (!Number.isFinite(v) || v < 0 || v > 100)) {
      return FAIL(`${labelText} percent must be between 0 and 100.`);
    }
  }

  await saveSettings({
    invoice_prefix: prefix,
    tax_percent: tax === null ? "0" : String(tax),
    processing_fee_percent: fee === null ? "0" : String(fee),
    razorpay_key_id: s(fd, "razorpay_key_id"),
    // Blank leaves the stored secret untouched (see saveSettings).
    razorpay_key_secret: s(fd, "razorpay_key_secret"),
  });
  revalidatePath("/settings");
  revalidatePath("/payments");
  return OK("Billing settings saved.");
}

/* --------------------------- Task categories --------------------------- */

export async function addCategory(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await requireUser(ADMIN_ROLES);
  const service = s(fd, "service");
  const name = s(fd, "name");
  if (!isServiceKey(service)) return FAIL("Pick a service.");
  if (name.length < 2) return FAIL("Category name needs at least 2 characters.");
  if (name.length > 120) return FAIL("Category name is too long (max 120).");

  const dupe = await queryOne<{ id: number; is_active: number }>(
    "SELECT id, is_active FROM task_categories WHERE service = ? AND name = ?",
    [service, name]
  );
  if (dupe) {
    if (dupe.is_active) return FAIL(`"${name}" already exists for this service.`);
    // Re-adding a name that was previously turned off simply switches it back on.
    await execute("UPDATE task_categories SET is_active = 1 WHERE id = ?", [dupe.id]);
    revalidatePath("/settings");
    return OK(`"${name}" re-enabled.`);
  }

  const next = await queryOne<{ n: number }>(
    "SELECT COALESCE(MAX(sort_order),-1) + 1 AS n FROM task_categories WHERE service = ?",
    [service]
  );
  await execute(
    "INSERT INTO task_categories (service, name, sort_order) VALUES (?,?,?)",
    [service, name, Number(next?.n ?? 0)]
  );
  revalidatePath("/settings");
  revalidatePath("/deliverables");
  return OK(`"${name}" added.`);
}

export async function renameCategory(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await requireUser(ADMIN_ROLES);
  const id = Number(fd.get("id"));
  const name = s(fd, "name");
  if (!id) return FAIL("Missing category.");
  if (name.length < 2) return FAIL("Category name needs at least 2 characters.");

  const cat = await queryOne<{ service: string; name: string }>(
    "SELECT service, name FROM task_categories WHERE id = ?",
    [id]
  );
  if (!cat) return FAIL("Category not found.");
  if (cat.name === name) return OK("No change.");

  const clash = await queryOne<{ id: number }>(
    "SELECT id FROM task_categories WHERE service = ? AND name = ? AND id <> ?",
    [cat.service, name, id]
  );
  if (clash) return FAIL(`"${name}" already exists for this service.`);

  await execute("UPDATE task_categories SET name = ? WHERE id = ?", [name, id]);
  // Carry existing tasks across so nothing loses its category.
  await execute(
    "UPDATE deliverables SET content_category = ? WHERE content_category = ? AND service = ?",
    [name, cat.name, cat.service]
  );

  revalidatePath("/settings");
  revalidatePath("/deliverables");
  revalidatePath("/today");
  return OK(`Renamed to "${name}".`);
}

export async function toggleCategory(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await requireUser(ADMIN_ROLES);
  const id = Number(fd.get("id"));
  if (!id) return FAIL("Missing category.");
  const cat = await queryOne<{ name: string; is_active: number }>(
    "SELECT name, is_active FROM task_categories WHERE id = ?",
    [id]
  );
  if (!cat) return FAIL("Category not found.");

  const next = cat.is_active ? 0 : 1;
  await execute("UPDATE task_categories SET is_active = ? WHERE id = ?", [next, id]);
  revalidatePath("/settings");
  revalidatePath("/deliverables");
  return OK(next ? `"${cat.name}" enabled.` : `"${cat.name}" hidden from new tasks.`);
}

/* ----------------------------- Danger zone ----------------------------- */

/**
 * Wipe every task so the portal can be started fresh. Clients, team and
 * settings are untouched; feedback/comments cascade with their deliverable.
 * Guarded by a typed confirmation so it can't fire on a stray click.
 */
export async function clearAllTasks(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await requireUser(SUPER_ADMIN_ROLES);
  if (s(fd, "confirm").toUpperCase() !== "DELETE") {
    return FAIL('Type DELETE to confirm — nothing was removed.');
  }

  const before = await queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM deliverables");
  const total = Number(before?.n ?? 0);
  if (total === 0) return OK("There were no tasks to clear.");

  await execute("DELETE FROM deliverables");

  for (const p of ["/deliverables", "/today", "/approvals", "/dashboard", "/reports", "/poster", "/portal"]) {
    revalidatePath(p);
  }
  return OK(`Cleared ${total} task${total === 1 ? "" : "s"}. Clients and team were kept.`);
}

/* ------------------------------- Team ------------------------------- */

const STAFF_ROLES_WRITABLE: Role[] = ["admin", "poster_designer", "crm", "super_admin"];

export async function addTeamMember(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await requireUser(SUPER_ADMIN_ROLES);
  const name = s(fd, "name");
  const email = s(fd, "email").toLowerCase();
  const password = String(fd.get("password") || "");
  const role = s(fd, "role") as Role;

  if (name.length < 2) return FAIL("Enter a name.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return FAIL("Enter a valid email address.");
  if (!STAFF_ROLES_WRITABLE.includes(role)) return FAIL("Pick a role.");
  if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    return FAIL("Password must be at least 8 characters with letters and numbers.");
  }

  const exists = await queryOne<{ id: number }>("SELECT id FROM users WHERE email = ?", [email]);
  if (exists) return FAIL("That email already has an account.");

  const hash = await bcrypt.hash(password, env.bcryptRounds);
  await execute("INSERT INTO users (name, email, password_hash, role) VALUES (?,?,?,?)", [
    name,
    email,
    hash,
    role,
  ]);
  revalidatePath("/settings");
  return OK(`${name} added to the team.`);
}

export async function setTeamMemberActive(
  _prev: ActionState,
  fd: FormData
): Promise<ActionState> {
  const me = await requireUser(SUPER_ADMIN_ROLES);
  const id = Number(fd.get("id"));
  if (!id) return FAIL("Missing user.");
  if (id === me.id) return FAIL("You can't deactivate your own account.");

  const u = await queryOne<{ name: string; role: string; is_active: number }>(
    "SELECT name, role, is_active FROM users WHERE id = ?",
    [id]
  );
  if (!u) return FAIL("User not found.");

  const next = u.is_active ? 0 : 1;
  if (!next && u.role === "super_admin") {
    const others = await queryOne<{ n: number }>(
      "SELECT COUNT(*) AS n FROM users WHERE role = 'super_admin' AND is_active = 1 AND id <> ?",
      [id]
    );
    if (Number(others?.n ?? 0) === 0) {
      return FAIL("Keep at least one active super admin.");
    }
  }

  await execute("UPDATE users SET is_active = ? WHERE id = ?", [next, id]);
  if (!next) {
    await execute("UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ?", [id]);
  }
  revalidatePath("/settings");
  return OK(next ? `${u.name} reactivated.` : `${u.name} deactivated.`);
}

export async function renameTeamMember(
  _prev: ActionState,
  fd: FormData
): Promise<ActionState> {
  await requireUser(SUPER_ADMIN_ROLES);
  const id = Number(fd.get("id"));
  const name = s(fd, "name");
  if (!id) return FAIL("Missing user.");
  if (name.length < 2) return FAIL("Enter a name (min 2 characters).");
  if (name.length > 120) return FAIL("That name is too long (max 120).");

  const u = await queryOne<{ name: string }>("SELECT name FROM users WHERE id = ?", [id]);
  if (!u) return FAIL("User not found.");
  if (u.name === name) return OK("No change.");

  await execute("UPDATE users SET name = ? WHERE id = ?", [name, id]);
  revalidatePath("/settings");
  return OK(`Renamed to ${name}.`);
}

/**
 * Permanently remove a staff account. Their work is preserved: the schema
 * nulls out deliverables.assigned_to / created_by and task_comments.author_id,
 * while their own sessions, notifications and CRM client access cascade away.
 */
export async function deleteTeamMember(
  _prev: ActionState,
  fd: FormData
): Promise<ActionState> {
  const me = await requireUser(SUPER_ADMIN_ROLES);
  const id = Number(fd.get("id"));
  if (!id) return FAIL("Missing user.");
  if (id === me.id) return FAIL("You can't delete your own account.");

  const u = await queryOne<{ name: string; role: string }>(
    "SELECT name, role FROM users WHERE id = ?",
    [id]
  );
  if (!u) return FAIL("User not found.");
  if (u.role === "client") {
    return FAIL("Client logins are managed from the Clients module.");
  }
  if (u.role === "super_admin") {
    const others = await queryOne<{ n: number }>(
      "SELECT COUNT(*) AS n FROM users WHERE role = 'super_admin' AND is_active = 1 AND id <> ?",
      [id]
    );
    if (Number(others?.n ?? 0) === 0) {
      return FAIL("Keep at least one active super admin.");
    }
  }

  await execute("DELETE FROM users WHERE id = ?", [id]);
  revalidatePath("/settings");
  revalidatePath("/deliverables");
  return OK(`${u.name} deleted. Their tasks were kept and are now unassigned.`);
}

export async function resetTeamPassword(
  _prev: ActionState,
  fd: FormData
): Promise<ActionState> {
  await requireUser(SUPER_ADMIN_ROLES);
  const id = Number(fd.get("id"));
  const password = String(fd.get("password") || "");
  if (!id) return FAIL("Missing user.");
  if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    return FAIL("Password must be at least 8 characters with letters and numbers.");
  }
  const u = await queryOne<{ name: string; role: string }>(
    "SELECT name, role FROM users WHERE id = ?",
    [id]
  );
  if (!u) return FAIL("User not found.");

  const hash = await bcrypt.hash(password, env.bcryptRounds);
  await execute("UPDATE users SET password_hash = ? WHERE id = ?", [hash, id]);
  await execute("UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ?", [id]);
  revalidatePath("/settings");
  return OK(`Password reset for ${u.name}. They'll need to sign in again.`);
}
