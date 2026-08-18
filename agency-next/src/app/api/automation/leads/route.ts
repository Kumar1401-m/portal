/**
 * POST /api/automation/leads
 *
 * Drops an enquiry into the pipeline from outside the portal — a Meta lead-ad
 * form, a website contact form, a WhatsApp bot.
 *
 * Body:
 *   { "name": "Ravi", "phone": "+91…", "email": "…", "company": "…",
 *     "source": "ads", "value": 25000, "note": "asked about reels" }
 *
 * Only `name` and one of phone/email are required — a lead nobody can reach is
 * a note, not a lead.
 *
 * Idempotent on contact details: the same phone or email arriving twice
 * updates the existing lead's note rather than filling the board with
 * duplicates of one person who submitted a form three times. That is the
 * common case with ad forms, and a duplicate pipeline is worse than a missing
 * line in a note.
 *
 * Auth: Authorization: Bearer <N8N_API_KEY>
 */
import { readAuthorized, ok, fail, asStr } from "@/lib/automation-api";
import { createLead, findByContact, isSource, leadsReady } from "@/lib/leads";
import { execute } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const { response, body } = await readAuthorized(request);
  if (response) return response;

  if (!(await leadsReady())) {
    return fail("The leads table isn't in this database yet.", 503, "schema");
  }

  const name = asStr(body.name);
  const phone = asStr(body.phone);
  const email = asStr(body.email);
  if (!name) return fail("A lead needs a name.", 400, "no_name");
  if (!phone && !email) return fail("A lead needs a phone number or an email.", 400, "no_contact");

  const source = asStr(body.source);
  const note = asStr(body.note);

  const existing = await findByContact(phone, email);
  if (existing) {
    if (note) {
      // Appended, not replaced. The second submission usually says something
      // the first did not, and overwriting loses whichever one mattered.
      await execute(
        "UPDATE leads SET note = CONCAT(COALESCE(CONCAT(note, '\n\n'), ''), ?) WHERE id = ?",
        [note.slice(0, 2000), existing]
      );
    }
    return ok({ id: existing, created: false });
  }

  const valueRaw = Number(body.value);
  const id = await createLead({
    name,
    company: asStr(body.company),
    phone,
    email,
    source: source && isSource(source) ? source : "website",
    value: Number.isFinite(valueRaw) && valueRaw > 0 ? valueRaw : 0,
    note,
  });

  return ok({ id, created: true }, 201);
}
