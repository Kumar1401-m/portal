"use server";

import { redirect } from "next/navigation";
import { clearSessionCookie } from "@/lib/auth";

/** Server action: log out and return to the login screen. */
export async function logout(): Promise<void> {
  await clearSessionCookie();
  redirect("/login");
}
