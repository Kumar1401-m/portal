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
import { readAuthorized, ok, fail, asInt, asStr, asDateTime } from "@/lib/automation-api";
import { queryOne } from "@/lib/db";
import { sendPostPublishedEmail } from "@/lib/email";
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
  const target = deliverableId
    ? await queryOne<Target>(
        `SELECT c.id AS client_id, c.company_name, c.contact_person, c.email,
                COALESCE(NULLIF(c.whatsapp_number,''), c.phone) AS whatsapp,
                d.title, d.caption, d.instagram_permalink AS permalink,
                COALESCE(d.instagram_posted_at, d.posted_at) AS posted_at
           FROM deliverables d JOIN clients c ON c.id = d.client_id
          WHERE d.id = ?`,
        [deliverableId]
      )
    : await queryOne<Target>(
        `SELECT c.id AS client_id, c.company_name, c.contact_person, c.email,
                COALESCE(NULLIF(c.whatsapp_number,''), c.phone) AS whatsapp,
                '' AS title, NULL AS caption, NULL AS permalink, NULL AS posted_at
           FROM clients c WHERE c.id = ?`,
        [clientId]
      );

  if (!target) return fail("No such deliverable or client.", 404, "not_found");

  // A caller may override the display fields (useful for a client-level send
  // that has no deliverable behind it), but never the recipient.
  const title = asStr(body.title) || target.title || "Your latest post";
  const permalink = asStr(body.permalink) || target.permalink;
  const postedAt = asDateTime(body.posted_at) || target.posted_at;

  const requested = Array.isArray(body.channels)
    ? body.channels.map((c) => String(c).toLowerCase())
    : ["email", "whatsapp"];

  const result: Record<string, unknown> = {};

  if (requested.includes("email")) {
    const sent = await sendPostPublishedEmail(
      {
        company_name: target.company_name,
        contact_person: target.contact_person,
        email: target.email,
      },
      { title, permalink, caption: target.caption, postedAt, platform: "Instagram" }
    );
    result.email = { sent, to: target.email };
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

  // In-app notification too, with mail off — the formal email above already
  // went out and a second generic copy would just be noise.
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
