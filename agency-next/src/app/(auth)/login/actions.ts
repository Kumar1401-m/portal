"use server";

import { redirect } from "next/navigation";
import bcrypt from "bcryptjs";
import { queryOne, execute } from "@/lib/db";
import {
  signToken,
  setSessionCookie,
  homeForRole,
  type Role,
} from "@/lib/auth";

export type LoginState = { error?: string };

type UserRow = {
  id: number;
  name: string;
  email: string;
  role: Role;
  is_active: number;
  password_hash: string;
};

/** Server action: authenticate against the existing users table. */
export async function login(
  _prev: LoginState,
  formData: FormData
): Promise<LoginState> {
  const email = String(formData.get("email") || "").trim().toLowerCase();
  const password = String(formData.get("password") || "");

  if (!email || !password) {
    return { error: "Enter your email and password." };
  }

  const user = await queryOne<UserRow>(
    "SELECT id, name, email, role, is_active, password_hash FROM users WHERE email = ?",
    [email]
  );

  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return { error: "Invalid email or password." };
  }
  if (!user.is_active) {
    return { error: "Your account is disabled. Contact the agency." };
  }

  await execute("UPDATE users SET last_login_at = NOW() WHERE id = ?", [user.id]);

  const token = signToken(user.id, user.role);
  await setSessionCookie(token);

  redirect(homeForRole(user.role));
}
