"use server";

import { revalidatePath } from "next/cache";
import { queryOne, execute, hasColumn } from "@/lib/db";
import { requireUser, STAFF_ROLES } from "@/lib/auth";
import {
  presignUpload,
  buildStaffAvatarKey,
  deleteObject,
  isStorageConfigured,
  resolveAvatarUrl,
} from "@/lib/storage";

/**
 * A staff member's own profile picture.
 *
 * The same signed-PUT flow the client portal has had all along, pointed at
 * `users` instead of `clients` — the browser uploads straight to R2 and the
 * portal only ever stores the key. Everyone on the team gets it, not only the
 * super admin: a board of tasks is easier to scan by face than by two letters
 * in a circle, and the person who most needs recognising is usually the one
 * with the least reason to visit Settings.
 *
 * Everything here is scoped to the caller's own row. There is deliberately no
 * "change someone else's picture" path, even for a super admin — it would be
 * a way to put a face on somebody else's actions.
 */

export type AvatarPresign =
  | { ok: true; uploadUrl: string; key: string }
  | { ok: false; error: string };

export async function getStaffAvatarUploadUrl(filename: string): Promise<AvatarPresign> {
  const user = await requireUser(STAFF_ROLES);

  if (!(await isStorageConfigured())) {
    return { ok: false, error: "Image storage isn't set up yet — see Settings → Storage." };
  }

  const key = buildStaffAvatarKey(user.id, filename);
  const signed = await presignUpload(key, 600);
  if (!signed) return { ok: false, error: "Couldn't prepare the upload." };

  return { ok: true, uploadUrl: signed.uploadUrl, key };
}

export type AvatarSave = { ok: boolean; error?: string; url?: string };

export async function saveStaffAvatar(key: string): Promise<AvatarSave> {
  const user = await requireUser(STAFF_ROLES);

  /*
   * Only ever a key we would have generated for *this* user. Without it the
   * action takes any string, and somebody's face can be pointed at any object
   * in the bucket — another client's video included.
   *
   * A literal prefix and a literal regex, rather than a pattern built from a
   * template. The built version is written `\\d` and reads `\d`, and getting
   * that wrong fails silently in the safe direction: every real upload is
   * refused as "not yours", which looks like a broken uploader and not like a
   * broken check.
   */
  const prefix = `avatars/staff/${user.id}/`;
  if (!key.startsWith(prefix) || !/^\d+\.[a-z0-9]{1,5}$/.test(key.slice(prefix.length))) {
    return { ok: false, error: "That upload doesn't belong to this account." };
  }

  if (!(await hasColumn("users", "avatar_url"))) {
    return {
      ok: false,
      error: "Profile pictures need one database change — a super admin can apply it in Settings → Database.",
    };
  }

  const existing = await queryOne<{ avatar_url: string | null }>(
    "SELECT avatar_url FROM users WHERE id = ?",
    [user.id]
  );

  await execute("UPDATE users SET avatar_url = ? WHERE id = ?", [key, user.id]);

  // Bin the previous upload, but never something pasted in as a URL.
  const old = existing?.avatar_url;
  if (old && !/^https?:\/\//i.test(old) && old !== key) {
    await deleteObject(old).catch(() => false);
  }

  // The picture is in the top bar of every page, so the whole shell is stale.
  revalidatePath("/", "layout");

  return { ok: true, url: (await resolveAvatarUrl(key)) ?? undefined };
}

/** Back to initials. */
export async function removeStaffAvatar(): Promise<AvatarSave> {
  const user = await requireUser(STAFF_ROLES);
  if (!(await hasColumn("users", "avatar_url"))) return { ok: true };

  const existing = await queryOne<{ avatar_url: string | null }>(
    "SELECT avatar_url FROM users WHERE id = ?",
    [user.id]
  );
  await execute("UPDATE users SET avatar_url = NULL WHERE id = ?", [user.id]);

  const old = existing?.avatar_url;
  if (old && !/^https?:\/\//i.test(old)) await deleteObject(old).catch(() => false);

  revalidatePath("/", "layout");
  return { ok: true };
}
