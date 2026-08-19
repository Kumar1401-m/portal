import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Sparkles, TriangleAlert } from "lucide-react";
import { requireUser, ADMIN_OR_CRM_ROLES } from "@/lib/auth";
import { canAccessClient } from "@/lib/crm";
import { getClientDetail } from "@/lib/clients";
import { getKnowledge, completeness } from "@/lib/knowledge";
import { buildBrief, cityOf } from "@/lib/content-ai";
import { modelConfigured } from "@/lib/ai-engines";
import { Card, CardContent } from "@/components/ui/card";
import { buttonClasses } from "@/components/ui/button";
import { thisMonthKey } from "@/lib/date-range";
import { Studio } from "./studio";
import { LearnedPanel } from "./learned-panel";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const c = await getClientDetail(Number(id));
  return { title: c ? `${c.company_name} · Content studio` : "Content studio" };
}

/**
 * The content studio for one client.
 *
 * Inside the client module rather than a tool of its own, because every one of
 * these five reads that client's brand knowledge and that client's
 * performance — a studio with a client picker at the top would be the same
 * page with an extra step and a way to generate a script for the wrong account.
 *
 * The brief is built here, on the server, only to answer one question: does
 * this account have enough history for the advice to be grounded? Nothing is
 * generated until somebody presses something.
 */
export default async function StudioPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser(ADMIN_OR_CRM_ROLES);
  const { id } = await params;
  const clientId = Number(id);
  if (!Number.isInteger(clientId) || !(await canAccessClient(user, clientId))) notFound();

  const client = await getClientDetail(clientId);
  if (!client) notFound();

  const [knowledge, brief, city] = await Promise.all([
    getKnowledge(clientId),
    buildBrief(clientId).catch(() => null),
    cityOf(clientId),
  ]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start gap-3">
        <Link href={`/clients/${clientId}`} className={buttonClasses({ variant: "ghost", size: "icon" })}>
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Sparkles className="h-6 w-6 text-primary" /> Content studio
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {client.company_name} — strategy, ideas, scripts, thumbnails and SEO, from what this
            account has actually been rewarded for.
          </p>
        </div>
      </div>

      {!modelConfigured() ? (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardContent className="flex items-start gap-3 p-4 text-sm">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <p>
              No model key is configured, so nothing here can generate. Add{" "}
              <span className="font-mono text-xs">GEMINI_API_KEY</span> and these five switch on
              together.
            </p>
          </CardContent>
        </Card>
      ) : null}

      <Studio
        clientId={clientId}
        clientName={client.company_name}
        month={thisMonthKey()}
        city={city}
        grounded={brief?.grounded ?? false}
        knowledgeFilled={completeness(knowledge)}
            /* Rendered here, on the server, and handed to the client component:
               the loop reads the database and the studio is a browser page. */
            learned={<LearnedPanel clientId={clientId} />}
      />
    </div>
  );
}
