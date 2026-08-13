import { PenLine, Check } from "lucide-react";
import { requireUser, ADMIN_OR_CRM_ROLES } from "@/lib/auth";
import { crmClientIds } from "@/lib/crm";
import { hasColumn } from "@/lib/db";
import { getContentBoard } from "@/lib/content";
import { Card, CardContent } from "@/components/ui/card";
import { ClientCard, type CardGroup } from "./client-card";

export const metadata = { title: "Content · NVK Hub" };
export const dynamic = "force-dynamic";

/**
 * The content desk.
 *
 * Its own board, off Today's Tasks, because writing the month's copy is not
 * the same job as running the day. It used to be thirty rows on the day board
 * all reading "yet to start", which is both the largest thing on that screen
 * and the least urgent — and it buried the four things that were late.
 *
 * A piece leaves here the moment it goes to the client. From then on it is
 * waiting on somebody, which is what Today's Tasks is for, so that is where
 * it shows.
 */
export default async function ContentPage() {
  const user = await requireUser(ADMIN_OR_CRM_ROLES);
  const scopeIds = await crmClientIds(user);
  const [hasApproval, hasSentAt] = await Promise.all([
    hasColumn("clients", "content_approval"),
    hasColumn("deliverables", "content_sent_at"),
  ]);
  const board = await getContentBoard(scopeIds, hasApproval, hasSentAt);

  // Sending to a client's own group is the same act as the two approval gates,
  // and follows the same rule.
  const canSend = user.role === "super_admin" || user.role === "crm";

  const toWrite = board.reduce((n, g) => n + g.toWrite.length, 0);
  const ready = board.reduce((n, g) => n + g.ready.length, 0);
  const withClient = board.reduce((n, g) => n + g.withClient.length, 0);

  const groups: CardGroup[] = board.map((g) => ({
    clientId: g.clientId,
    companyName: g.companyName,
    hasGroup: g.hasGroup,
    approvesContent: g.approvesContent,
    properties: g.properties.map((p) => ({
      name: p.name,
      toWrite: p.toWrite.map(row),
      ready: p.ready.map(row),
      withClient: p.withClient.map(row),
    })),
    toWrite: g.toWrite.map(row),
    ready: g.ready.map(row),
    withClient: g.withClient.map(row),
  }));

  return (
    <div className="space-y-5">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <PenLine className="h-6 w-6 text-primary" />
          Content
        </h1>
        <p className="text-sm text-muted-foreground">
          {toWrite > 0 ? `${toWrite} to write` : "Everything is written"}
          {ready > 0 ? ` · ${ready} written and ready to send` : ""}
          {withClient > 0 ? ` · ${withClient} with clients` : ""}.
        </p>
      </div>

      {groups.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-14 text-center">
            <Check className="h-8 w-8 text-muted-foreground" />
            <p className="font-medium">No content waiting</p>
            <p className="max-w-sm text-sm text-muted-foreground">
              Every brief is written and signed off. New tasks appear here as soon as they are
              created, before anything can be designed or edited.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {groups.map((g) => (
            <ClientCard key={g.clientId} group={g} canSend={canSend} />
          ))}
        </div>
      )}
    </div>
  );
}

function row(r: {
  id: number;
  title: string;
  due_date: string | null;
  description: string | null;
  assignee_name: string | null;
  campaign: string | null;
}) {
  return {
    id: r.id,
    title: r.title,
    dueDate: r.due_date,
    description: r.description,
    assigneeName: r.assignee_name,
    property: (r.campaign ?? "").trim(),
  };
}
