/**
 * GET /api/automation/whoami
 *
 * Why a key was rejected.
 *
 * Every other automation endpoint answers a failed key with a flat 401, which
 * is right for them and useless for setting one up: "Unauthorized" is the same
 * answer whether the header is absent, truncated, carrying a stray space, or
 * simply the wrong secret. Diagnosing that by editing a credential and
 * re-running is guesswork with a two-minute loop.
 *
 * This describes what arrived and how it compares, and never sends the secret
 * back. Lengths given are of what the caller supplied — their own input — and
 * the comparison to what is configured is reported only as true or false, so
 * nothing here tells you a secret you did not already have.
 *
 * Deliberately unauthenticated. An endpoint for diagnosing failed auth cannot
 * itself require auth to work.
 */
import { NextResponse } from "next/server";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const header = request.headers.get("authorization") || "";
  const apiKeyHeader = request.headers.get("x-api-key") || "";

  const hadBearer = /^Bearer\s/i.test(header);
  const bearer = hadBearer ? header.replace(/^Bearer\s+/i, "") : header;
  const key = bearer || apiKeyHeader;

  const cron = env.automation.cronSecret || "";
  const automationKey = env.automation.apiKey || "";

  // Whitespace is the failure nobody sees: a copied secret that picked up a
  // trailing newline looks identical in a form field and never matches.
  const trimmed = key.trim();
  const hasEdgeWhitespace = key !== trimmed;

  const matchesCron = Boolean(cron) && key === cron;
  const matchesAutomation = Boolean(automationKey) && key === automationKey;
  const matchesCronIfTrimmed = Boolean(cron) && !matchesCron && trimmed === cron;

  let hint: string;
  if (!header && !apiKeyHeader) {
    hint =
      "No Authorization header arrived. In n8n the HTTP node must have a credential selected, and the credential's Name field must be exactly 'Authorization'.";
  } else if (matchesCron || matchesAutomation) {
    hint = "This key is accepted. The publish endpoint will work with it.";
  } else if (matchesCronIfTrimmed) {
    hint =
      "The key is right but has a space or line break around it. Re-copy it without the surrounding whitespace.";
  } else if (!cron) {
    hint = "No CRON_SECRET is configured on this deployment, so nothing can match it.";
  } else if (key.length !== cron.length) {
    hint = `The key is ${key.length} characters; the configured secret is a different length. It was probably truncated when copied, or the wrong value was pasted.`;
  } else {
    hint =
      "The key is the right length but a different value. Check it against CRON_SECRET in the Vercel project's environment variables.";
  }

  return NextResponse.json({
    ok: matchesCron || matchesAutomation,
    received: {
      authorization_header: Boolean(header),
      x_api_key_header: Boolean(apiKeyHeader),
      bearer_prefix: hadBearer,
      key_length: key.length,
      surrounding_whitespace: hasEdgeWhitespace,
    },
    configured: {
      cron_secret: Boolean(cron),
      automation_key: Boolean(automationKey),
    },
    matches: {
      cron_secret: matchesCron,
      automation_key: matchesAutomation,
      cron_secret_after_trimming: matchesCronIfTrimmed,
      same_length_as_cron_secret: Boolean(cron) && key.length === cron.length,
    },
    hint,
  });
}
