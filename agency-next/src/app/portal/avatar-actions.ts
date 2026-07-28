"use server";

import { revalidatePath } from "next/cache";
import { queryOne, execute } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import {
  presignUpload,
  buildAvatarKey,
  deleteObject,
  isStorageConfigured,
  resolveAvatarUrl,
} from "@/lib/storage";

export type AvatarPresign =
  | { ok: true; uploadUrl: string; key: string }
  | { ok: false; error: string };

/** Signed PUT so the client's browser uploads their picture straight to R2. */
export async function getAvatarUploadUrl(filename: string): Promise<AvatarPresign> {
  const user = await requireUser(["client"]);
  if (!user.clientId) return { ok: false, error: "No client account linked to this login." };

  if (!(await isStorageConfigured())) {
    return { ok: false, error: "Image storage isn't set up yet — ask the agency to finish setup." };
  }

  const key = buildAvatarKey(user.clientId, filename);
  const signed = await presignUpload(key, 600);
  if (!signed) return { ok: false, error: "Couldn't prepare the upload." };

  return { ok: true, uploadUrl: signed.uploadUrl, key };
}

export type AvatarSave = { ok: boolean; error?: string; url?: string };

/** Point the client record at the newly uploaded picture. */
export async function saveAvatar(key: string): Promise<AvatarSave> {
  const user = await requireUser(["client"]);
  if (!user.clientId) return { ok: false, error: "No client account linked to this login." };

  // Only ever accept a key we would have generated for *this* client.
  if (!new RegExp(`^avatars/${user.clientId}/\\d+\\.[a-z0-9]{1,5}$`).test(key)) {
    return { ok: false, error: "That upload doesn't belong to this account." };
  }

  const existing = await queryOne<{ company_logo_url: string | null }>(
    "SELECT company_logo_url FROM clients WHERE id = ?",
    [user.clientId]
  );

  await execute("UPDATE clients SET company_logo_url = ? WHERE id = ?", [key, user.clientId]);

  // Bin the previous upload (but never an externally hosted logo).
  const old = existing?.company_logo_url;
  if (old && !/^https?:\/\//i.test(old) && old !== key) {
    await deleteObject(old).catch(() => false);
  }

  revalidatePath("/portal");
  revalidatePath("/portal/content");
  revalidatePath("/portal/invoices");

  return { ok: true, url: (await resolveAvatarUrl(key)) ?? undefined };
}
