import Link from "next/link";
import { Sparkles, TriangleAlert } from "lucide-react";
import { requireUser, ADMIN_OR_CRM_ROLES } from "@/lib/auth";
import { crmClientIds, canAccessClient } from "@/lib/crm";
import { getClientsMini } from "@/lib/deliverables";
import { getClientDetail } from "@/lib/clients";
import { getKnowledge, completeness } from "@/lib/knowledge";
import { buildBrief, cityOf } from "@/lib/content-ai";
import { modelConfigured } from "@/lib/ai-engines";
import { Card, CardContent } from "@/components/ui/card";
import { thisMonthKey } from "@/lib/date-range";
import { Studio } from "../clients/[id]/studio/studio";
import { StudioClientPicker } from "./client-picker";

export const metadata = { title: "Content studio · NVK Hub" };
export const dynamic = "force-dynamic";

/**
 * The content studio, reached from the nav rather than through a client.
 *
 * The same five tools as `/clients/[id]/studio` — the panels are imported, not
 * copied, so the two cannot drift apart. What differs is only how you arrive:
 * from Production when you sit down to write this week's content and pick the
 * account, or from a client's page when you are already looking at them.
 *
 * It still cannot open on nobody. Every tool is grounded in one client's brand
 * knowledge and one client's performance, so with no client chosen the page is
 * the picker and a sentence saying why.
 */
export default async function StudioPage({
  searchParams,
}: {
  searchParams: Promise<{ client?: string }>;
}) {
  const user = await requireUser(ADMIN_OR_CRM_ROLES);
  const [sp, scope] = await Promise.all([searchParams, crmClientIds(user)]);
  const clients = await getClientsMini(scope);

  const wanted = Number(sp.client);
  // A client id that is not this user's own is ignored rather than refused —
  // a crm following a colleague's link lands on their own picker.
  const clientId =
    Number.isInteger(wanted) && wanted > 0 && (await canAccessClient(user, wanted)) ? wanted : null;

  const [client, knowledge, brief, city] = clientId
    ? await Promise.all([
        getClientDetail(clientId),
        getKnowledge(clientId),
        buildBrief(clientId).catch(() => null),
        cityOf(clientId),
      ])
    : [null, null, null, null];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Sparkles className="h-6 w-6 text-primary" /> Content studio
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {client
              ? `${client.company_name} — strategy, ideas, scripts, thumbnails and SEO, from what this account has actually been rewarded for.`
              : "Strategy, ideas, scripts, thumbnails and SEO — written for one client at a time."}
          </p>
        </div>
        <StudioClientPicker clients={clients} current={clientId} />
      </div>

      {!modelConfigured() ? (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardContent className="flex items-start gap-3 p-4 text-sm">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <p>
              No model key is configured, so nothing here can generate. Add{" "}
              <span className="font-mono text-xs">GEMINI_API_KEY</span> and these switch on
              together.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {clientId && client && knowledge ? (
        <>
          <Studio
            clientId={clientId}
            clientName={client.company_name}
            month={thisMonthKey()}
            city={city}
            grounded={brief?.grounded ?? false}
            knowledgeFilled={completeness(knowledge)}
          />
          <p className="text-xs text-muted-foreground">
            Writing for the wrong account is the one mistake this page makes easy — everything
            above is for{" "}
            <Link href={`/clients/${clientId}`} className="text-primary hover:underline">
              {client.company_name}
            </Link>
            .
          </p>
        </>
      ) : (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-14 text-center">
            <Sparkles className="h-8 w-8 text-muted-foreground" />
            <p className="font-medium">Pick a client to write for</p>
            <p className="max-w-md text-sm text-muted-foreground">
              Every tool here reads that client&apos;s brand knowledge and their own published
              performance. Without one it would write the same content any agency could have got
              from a free chatbot.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
