/**
 * GET /api/automation/instagram/check
 *
 * Whether each client could actually publish, asked of Meta rather than
 * guessed from what is stored.
 *
 * Setting this up has five places to go wrong — a user token where a Page
 * token was needed, a token that expires in sixty days, a missing permission,
 * a Page id typed into the Instagram field, auto-publish left unticked — and
 * every one of them fails the same way: nothing posts, silently, and nobody
 * finds out until a client asks where their reel is.
 *
 * Never returns a token. Reports what is true about each one: its type, when
 * it expires, what it can do, and whether it can see the account it is
 * attached to.
 *
 * Auth: Authorization: Bearer <CRON_SECRET>
 */
import { NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/lib/api-auth";
import { query } from "@/lib/db";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const GRAPH = "https://graph.facebook.com/v21.0";

type Row = {
  id: number;
  company_name: string;
  ig_user_id: string | null;
  ig_access_token: string | null;
  auto_publish: number | null;
};

async function graph(path: string, token: string) {
  const url = `${GRAPH}/${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  return r.json().catch(() => ({}));
}

export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  let clients: Row[];
  try {
    clients = await query<Row>(
      `SELECT id, company_name, ig_user_id, ig_access_token, auto_publish
         FROM clients WHERE status <> 'churned' ORDER BY company_name`
    );
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "query failed" },
      { status: 500 }
    );
  }

  const results = [];
  for (const c of clients) {
    // The client's own token, else the global one — the same order the
    // publisher itself uses, so this tests what would really be sent.
    const token = c.ig_access_token || env.meta.accessToken || "";
    const r: Record<string, unknown> = {
      client: c.company_name,
      ig_user_id: c.ig_user_id || null,
      token: c.ig_access_token ? "its own" : env.meta.accessToken ? "the global one" : "none",
      auto_publish: c.auto_publish === 1,
    };

    if (!c.ig_user_id) {
      r.ready = false;
      r.problem = "No Instagram Business account id on this client.";
      results.push(r);
      continue;
    }
    if (!token) {
      r.ready = false;
      r.problem = "No access token — neither on this client nor globally.";
      results.push(r);
      continue;
    }

    const dbg = (await graph(`debug_token?input_token=${encodeURIComponent(token)}`, token)) as {
      data?: { type?: string; is_valid?: boolean; expires_at?: number; scopes?: string[] };
    };
    const d = dbg.data;
    if (!d?.is_valid) {
      r.ready = false;
      r.problem = "Meta rejected this token — it has been reset, revoked or has expired.";
      results.push(r);
      continue;
    }

    r.token_type = d.type;
    r.expires = d.expires_at ? new Date(d.expires_at * 1000).toISOString() : "never";
    const scopes = d.scopes || [];
    const missing = ["instagram_basic", "instagram_content_publish"].filter((s) => !scopes.includes(s));
    if (missing.length) {
      r.ready = false;
      r.problem = `Token is missing ${missing.join(" and ")}.`;
      results.push(r);
      continue;
    }

    // The real test. Everything above can be right while the id in the
    // Instagram field is a Page id, which fails only at publish time with a
    // message that names neither the problem nor the fix.
    const acct = (await graph(`${c.ig_user_id}?fields=id,username`, token)) as {
      id?: string;
      username?: string;
      error?: { message?: string };
    };
    if (!acct.id) {
      r.ready = false;
      r.problem =
        `This token cannot see account ${c.ig_user_id}` +
        (acct.error?.message ? ` — Meta says: ${acct.error.message}` : "") +
        ". Usually the wrong page's token, or a Page id in the Instagram field.";
      results.push(r);
      continue;
    }

    r.instagram = acct.username ? `@${acct.username}` : acct.id;
    r.ready = true;
    if (d.type !== "PAGE") {
      r.warning = "This is a user token. It works, but it expires — a Page token never does.";
    }
    if (!r.auto_publish) {
      r.warning = "Ready, but auto-publish is off, so nothing will post without a person.";
    }
    results.push(r);
  }

  return NextResponse.json({
    ok: true,
    ready: results.filter((r) => r.ready).length,
    of: results.length,
    clients: results,
  });
}
