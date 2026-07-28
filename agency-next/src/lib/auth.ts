/**
 * Authentication: JWT signing/verification, session cookie, and the
 * `getSession` / `requireUser` helpers used by server components & actions.
 *
 * Mirrors the original portal's model: bcrypt password hashes in the `users`
 * table, JWT identity, role-based access (super_admin / admin / poster_designer
 * / client). Here the token lives in a single httpOnly cookie.
 */
import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import jwt from "jsonwebtoken";
import { queryOne } from "./db";
import { env } from "./env";

export const COOKIE_NAME = "erp_session";

export type Role = "super_admin" | "admin" | "poster_designer" | "crm" | "client";

export type SessionUser = {
  id: number;
  name: string;
  email: string;
  role: Role;
  clientId: number | null;
};

type UserRow = {
  id: number;
  name: string;
  email: string;
  role: Role;
  is_active: number;
  password_hash?: string;
};

/** Sign a session JWT for a user id. */
export function signToken(userId: number, role: Role): string {
  return jwt.sign({ sub: String(userId), role }, env.jwt.secret, {
    expiresIn: `${env.jwt.expiresDays}d`,
  });
}

/** Set the httpOnly session cookie. */
export async function setSessionCookie(token: string): Promise<void> {
  const jar = await cookies();
  jar.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.isProd,
    path: "/",
    maxAge: env.jwt.expiresDays * 24 * 60 * 60,
  });
}

/** Remove the session cookie (logout). */
export async function clearSessionCookie(): Promise<void> {
  const jar = await cookies();
  jar.delete(COOKIE_NAME);
}

/**
 * Resolve the current user from the session cookie, or null.
 * Cached per-request so repeated calls in a render don't re-hit the DB.
 */
export const getSession = cache(async (): Promise<SessionUser | null> => {
  const jar = await cookies();
  const token = jar.get(COOKIE_NAME)?.value;
  if (!token) return null;

  let sub: string;
  try {
    const payload = jwt.verify(token, env.jwt.secret) as { sub: string };
    sub = payload.sub;
  } catch {
    return null;
  }

  const user = await queryOne<UserRow>(
    "SELECT id, name, email, role, is_active FROM users WHERE id = ?",
    [Number(sub)]
  );
  if (!user || !user.is_active) return null;

  let clientId: number | null = null;
  if (user.role === "client") {
    const c = await queryOne<{ id: number }>(
      "SELECT id FROM clients WHERE user_id = ?",
      [user.id]
    );
    clientId = c ? c.id : null;
  }

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    clientId,
  };
});

/** Where each role lands after login / when hitting a page it can't see. */
export function homeForRole(role: Role): string {
  if (role === "client") return "/portal";
  if (role === "poster_designer") return "/poster";
  if (role === "crm") return "/deliverables";
  return "/dashboard";
}

/**
 * Require a logged-in user, optionally restricted to certain roles.
 * Redirects to /login if unauthenticated, or to the user's home if the role
 * isn't allowed. Returns the user for use in the page/action.
 */
export async function requireUser(roles?: Role[]): Promise<SessionUser> {
  const user = await getSession();
  if (!user) redirect("/login");
  if (roles && !roles.includes(user.role)) redirect(homeForRole(user.role));
  return user;
}

/** Staff = anyone who isn't a client. */
export const STAFF_ROLES: Role[] = ["super_admin", "admin", "poster_designer", "crm"];
/** Staff for the Posters module, which has no per-client scoping. */
export const POSTER_ROLES: Role[] = ["super_admin", "admin", "poster_designer"];
export const ADMIN_ROLES: Role[] = ["super_admin", "admin"];
/**
 * Modules a scoped "crm" user can also reach (Clients, Tasks, Today,
 * Approvals, Reports) — everything they see within these is further
 * filtered to their assigned clients via src/lib/crm.ts.
 */
export const ADMIN_OR_CRM_ROLES: Role[] = ["super_admin", "admin", "crm"];
/** A narrow set of sensitive actions (team management, billing, client archive,
 *  invoicing) are reserved for super_admin even though a plain admin can see
 *  everything else. */
export const SUPER_ADMIN_ROLES: Role[] = ["super_admin"];
