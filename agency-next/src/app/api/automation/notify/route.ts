/**
 * POST /api/automation/notify
 *
 * Step 5 — tell the client their post is live, by email and WhatsApp.
 *
 * The workflow could call Meta's messaging API itself, and the shipped n8n
 * workflow does exactly that for WhatsApp. This endpoint exists because the
 * *email* needs the portal's templates, branding and SMTP config, and because
 * routing both through one call keeps the recipient lookup in one place —
 * n8n never has to know which column a client's WhatsApp number lives in.
 *
 * `channels` selects which to send, so a workflow that already sent its own
 * WhatsApp message can ask for the email alone.
 *
 * Never fails the run: a client not hearing about a post is a problem, but it
 * is not a reason to mark a successful publish as failed. Each channel reports
 * its own outcome and the response is always 200 when authorised.
 *
 * Auth: Authorization: Bearer <N8N_API_KEY>
 * Body: { "deliverable_id": 12, "channels"?: ["email","whatsapp"] }
 *   or   { "client_id": 4, "title": "…", "permalink": "…" }
 */
import { readAuthorized, ok, fail, asInt, asStr } from "@/lib/automation-api";
import { facebookLinkOf } from "@/lib/facebook";
import { queryOne, hasColumn } from "@/lib/db";
import { sendPostPublishedWhatsApp } from "@/lib/whatsapp";
import { notifyClientById } from "@/lib/notify";

export const dynamic = "force-dynamic";

type Target = {
  client_id: number;
  company_name: string;
  contact_person: string | null;
  email: string | null;
  whatsapp: string | null;
  title: string;
  caption: string | null;
  permalink: string | null;
  /** The Facebook post, when the reel went there and not to Instagram. */
  facebook_post_id: string | null;
  facebook_permalink?: string | null;
  posted_at: string | null;
};

export async function POST(request: Request) {
  const { response, body } = await readAuthorized(request);
  if (response) return response;

  const deliverableId = asInt(body.deliverable_id);
  const clientId = asInt(body.client_id);
  if (!deliverableId && !clientId) {
    return fail("deliverable_id or client_id is required.", 400, "missing_target");
  }

  // Everything is read from the database rather than taken from the request:
  // the workflow shouldn't be able to send a client's notification to an
  // address of its own choosing, and the stored permalink is the one that was
  // actually published.
  /*
   * Named only when it exists — a column from a later migration listed
   * unconditionally is a hard SQL error on a database that has not run it,
   * and this route is how a client is told their post is live.
   */
  const hasFbLink = await hasColumn("deliverables", "facebook_permalink");
  const target = deliverableId
    ? await queryOne<Target>(
        `SELECT c.id AS client_id, c.company_name, c.contact_person, c.email,
                COALESCE(NULLIF(c.whatsapp_number,''), c.phone) AS whatsapp,
                d.title, d.caption, d.instagram_permalink AS permalink,
                d.facebook_post_id,
                ${hasFbLink ? "d.facebook_permalink," : ""}
                COALESCE(d.instagram_posted_at, d.posted_at) AS posted_at
           FROM deliverables d JOIN clients c ON c.id = d.client_id
          WHERE d.id = ?`,
        [deliverableId]
      )
    : await queryOne<Target>(
        `SELECT c.id AS client_id, c.company_name, c.contact_person, c.email,
                COALESCE(NULLIF(c.whatsapp_number,''), c.phone) AS whatsapp,
                '' AS title, NULL AS caption, NULL AS permalink,
                NULL AS facebook_post_id, NULL AS posted_at
           FROM clients c WHERE c.id = ?`,
        [clientId]
      );

  if (!target) return fail("No such deliverable or client.", 404, "not_found");

  // A caller may override the display fields (useful for a client-level send
  // that has no deliverable behind it), but never the recipient.
  const title = asStr(body.title) || target.title || "Your latest post";
  /*
   * The link goes to the post that exists.
   *
   * This sent `instagram_permalink` and nothing else, so a reel published to
   * the client's Facebook Page and not to Instagram arrived with no link at
   * all — a message telling somebody their post is live and giving them no
   * way to look at it.
   *
   * The platform name and the posted-at time went with the email. Both existed
   * only to fill its template, and neither the WhatsApp message nor the portal
   * notification uses either — so they are gone rather than left computed and
   * unread.
   */
  const fbLink = facebookLinkOf(target);
  const permalink = asStr(body.permalink) || target.permalink || fbLink;

  const requested = Array.isArray(body.channels)
    ? body.channels.map((c) => String(c).toLowerCase())
    : ["email", "whatsapp"];

  const result: Record<string, unknown> = {};

  /*
   * Email is accepted as a channel and does nothing, on purpose.
   *
   * A client is mailed once, at onboarding, and nothing after that — so this
   * reports honestly rather than pretending. Silently dropping the request
   * would leave whoever wired the caller believing an email went out, and
   * removing the channel outright would break every existing caller that
   * still names it.
   */
  if (requested.includes("email")) {
    result.email = { sent: false, skipped: "clients are only emailed at onboarding" };
  }

  if (requested.includes("whatsapp")) {
    const wa = await sendPostPublishedWhatsApp({
      to: target.whatsapp,
      clientName: target.contact_person || target.company_name,
      title,
      permalink,
    });
    result.whatsapp = { sent: wa.sent, message_id: wa.messageId ?? null, error: wa.error ?? null };
  }

  // The in-app notification, which with the email gone is now the record
  // the client keeps. The WhatsApp message above is the one they read.
  await notifyClientById(
    target.client_id,
    "general",
    "Your post is live",
    `"${title}" has been published to Instagram.`,
    permalink || "/portal",
    false
  );

  return ok({ notified: result });
}
