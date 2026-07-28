"use server";

import { revalidatePath } from "next/cache";
import { execute } from "./db";
import { requireUser } from "./auth";

/** Mark all of the current user's notifications as read. */
export async function markAllRead(): Promise<void> {
  const user = await requireUser();
  await execute("UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0", [user.id]);
  revalidatePath("/", "layout");
}
