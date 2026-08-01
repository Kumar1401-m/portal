/**
 * WhatsApp Cloud API — "your post is live" notifications.
 *
 * Mirrors email.ts: no-op safe. With no credentials configured every send logs
 * and returns false, so a caller is never blocked and the portal still works
 * for an agency that hasn't set WhatsApp up.
 *
 * n8n normally sends this message itself (one less hop between the publish and
 * the client hearing about it). This module exists so the same notification
 * can be fired from the portal — a manual "notify client" button, or an
 * install running without n8n at all.
 */
import "server-only";
import { env } from "./env";

/**
 * WhatsApp wants a bare international number: digits only, country code
 * included, no `+`, spaces or punctuation. A number stored as
 * "+91 98765 43210" is rejected outright, so normalise rather than trust.
 */
export function normalizeWhatsAppNumber(
  raw: string | null | undefined,
  defaultCountryCode = "91"
): string | null {
  if (!raw) return null;
  let digits = String(raw).replace(/\D/g, "");
  if (!digits) return null;

  // Indian numbers are often stored as 10 digits with the country code
  // implied. Anything already long enough is assumed to carry its own.
  if (digits.length === 10) digits = `${defaultCountryCode}${digits}`;
  // A leading 0 is a domestic trunk prefix and is never part of the
  // international form.
  if (digits.startsWith("0")) digits = `${defaultCountryCode}${digits.replace(/^0+/, "")}`;

  return digits.length >= 11 && digits.length <= 15 ? digits : null;
}

export type WhatsAppResult = { sent: boolean; messageId?: string; error?: string };

/**
 * Send a plain text message.
 *
 * Note on WhatsApp's rules: free-form text only reaches a user inside the
 * 24-hour window after they last messaged the business. Outside it Meta
 * requires an approved template, which is why `sendTemplate` exists and why
 * WHATSAPP_TEMPLATE_NAME is the production path — a client who hasn't
 * messaged you today will not receive a plain text send.
 */
export async function sendWhatsAppText(
  to: string | null | undefined,
  message: string
): Promise<WhatsAppResult> {
  const number = normalizeWhatsAppNumber(to);
  if (!number) return { sent: false, error: "No usable WhatsApp number." };
  if (!env.whatsapp.enabled) {
    console.info(`[whatsapp skipped — not configured] to=${number}`);
    return { sent: false, error: "WhatsApp is not configured." };
  }

  try {
    const res = await fetch(
      `https://graph.facebook.com/${env.whatsapp.apiVersion}/${env.whatsapp.phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.whatsapp.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: number,
          type: "text",
          // Link previews off: the Instagram permalink would otherwise expand
          // into a large card and bury the message.
          text: { preview_url: false, body: message.slice(0, 4096) },
        }),
      }
    );
    const data = (await res.json()) as {
      messages?: { id: string }[];
      error?: { message?: string };
    };
    if (!res.ok) {
      const error = data?.error?.message || `HTTP ${res.status}`;
      console.warn("[whatsapp failed]", error);
      return { sent: false, error };
    }
    return { sent: true, messageId: data?.messages?.[0]?.id };
  } catch (err) {
    const error = err instanceof Error ? err.message : "Unknown error";
    console.warn("[whatsapp failed]", error);
    return { sent: false, error };
  }
}

/**
 * Send an approved template — the only reliable way to reach a client who
 * hasn't messaged the business in the last 24 hours.
 *
 * `params` fill the template's {{1}}, {{2}}… placeholders in order, so the
 * template registered with Meta must expect them in the same order the caller
 * passes them.
 */
export async function sendWhatsAppTemplate(
  to: string | null | undefined,
  templateName: string,
  params: string[],
  languageCode = "en"
): Promise<WhatsAppResult> {
  const number = normalizeWhatsAppNumber(to);
  if (!number) return { sent: false, error: "No usable WhatsApp number." };
  if (!env.whatsapp.enabled) return { sent: false, error: "WhatsApp is not configured." };

  try {
    const res = await fetch(
      `https://graph.facebook.com/${env.whatsapp.apiVersion}/${env.whatsapp.phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.whatsapp.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: number,
          type: "template",
          template: {
            name: templateName,
            language: { code: languageCode },
            components: params.length
              ? [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }]
              : [],
          },
        }),
      }
    );
    const data = (await res.json()) as {
      messages?: { id: string }[];
      error?: { message?: string };
    };
    if (!res.ok) return { sent: false, error: data?.error?.message || `HTTP ${res.status}` };
    return { sent: true, messageId: data?.messages?.[0]?.id };
  } catch (err) {
    return { sent: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

/**
 * The post-published notification. Uses the configured template when there is
 * one (works at any hour), falling back to plain text (works inside the
 * 24-hour window) so a partly-configured install still notifies rather than
 * silently doing nothing.
 */
export async function sendPostPublishedWhatsApp(input: {
  to: string | null | undefined;
  clientName: string;
  title: string;
  permalink?: string | null;
}): Promise<WhatsAppResult> {
  const { to, clientName, title, permalink } = input;

  if (env.whatsapp.template) {
    const viaTemplate = await sendWhatsAppTemplate(to, env.whatsapp.template, [
      clientName,
      title,
      permalink || "your Instagram profile",
    ]);
    if (viaTemplate.sent) return viaTemplate;
  }

  const lines = [
    `Hi ${clientName},`,
    "",
    `Your post "${title}" is now live on Instagram. 🎉`,
    permalink ? `\nSee it here: ${permalink}` : "",
    "",
    `— ${env.appName}`,
  ].filter((l) => l !== undefined);

  return sendWhatsAppText(to, lines.join("\n"));
}
