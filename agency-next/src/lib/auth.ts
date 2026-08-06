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

export type Role =
  | "super_admin"
  | "admin"
  | "poster_designer"
  /** Cuts the videos. Lives in the Editing queue and nowhere else. */
  | "video_editor"
  | "crm"
  | "client";

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
    expiresIn: `${env.jwt.expiresMinutes}m`,
  });
}

/**
 * How much longer the cookie survives than the token inside it.
 *
 * The token is the thing that actually expires — an expired one is refused
 * whatever the cookie says. Letting the cookie linger a few minutes past it
 * means the server still receives something on the next request and can say
 * "your session expired" rather than presenting a bare login page to someone
 * who was working thirty seconds ago.
 */
const COOKIE_GRACE_MINUTES = 5;

/** Set the httpOnly session cookie. */
export async function setSessionCookie(token: string): Promise<void> {
  const jar = await cookies();
  jar.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.isProd,
    path: "/",
    maxAge: (env.jwt.expiresMinutes + COOKIE_GRACE_MINUTES) * 60,
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
    const payload = jwt.verify(token, env.jwt.secret) as {
      sub: string;
      iat?: number;
      exp?: number;
    };

    /*
     * Refuse a token that was granted a longer life than we now allow.
     *
     * Shortening the session only affects tokens signed afterwards, so without
     * this everyone already signed in would keep the session they were given —
     * up to a week — and the new rule would apply to nobody who was actually
     * using the portal when it changed. Comparing the token's own lifespan to
     * the current setting expires those immediately, and keeps doing so
     * automatically if the setting is ever shortened again.
     */
    if (payload.iat && payload.exp) {
      const grantedSeconds = payload.exp - payload.iat;
      // A minute of slack so a token signed exactly at the limit isn't
      // rejected by rounding.
      if (grantedSeconds > env.jwt.expiresMinutes * 60 + 60) return null;
    }

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
  if (role === "video_editor") return "/editor";
  if (role === "crm") return "/dashboard";
  return "/dashboard";
}

/**
 * Require a logged-in user, optionally restricted to certain roles.
 * Redirects to /login if unauthenticated, or to the user's home if the role
 * isn't allowed. Returns the user for use in the page/action.
 */
export async function requireUser(roles?: Role[]): Promise<SessionUser> {
  const user = await getSession();
  if (!user) {
    // A cookie that's still here but no longer resolves to a user is a session
    // that ran out, which is worth saying. Landing on a blank login screen
    // mid-task otherwise reads as the portal having lost your work.
    const jar = await cookies();
    redirect(jar.get(COOKIE_NAME) ? "/login?expired=1" : "/login");
  }
  if (roles && !roles.includes(user.role)) redirect(homeForRole(user.role));
  return user;
}

/** Staff = anyone who isn't a client. */
export const STAFF_ROLES: Role[] = [
  "super_admin",
  "admin",
  "poster_designer",
  "video_editor",
  "crm",
];
/** Staff for the Posters module, which has no per-client scoping. */
export const POSTER_ROLES: Role[] = ["super_admin", "admin", "poster_designer"];
/**
 * The Editing module, and the parts of a task an editor has to touch to do the
 * work: upload the cut, write the caption, move it along. No per-client
 * scoping, the same as Posters — a small agency's editors work the whole
 * board, and inventing a second scoping model would only be a way to lock
 * someone out of a video they were asked to cut.
 */
export const EDITOR_ROLES: Role[] = ["super_admin", "admin", "video_editor"];
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
