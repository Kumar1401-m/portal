import { requireUser } from "@/lib/auth";
import { getNotifications, getUnreadCount } from "@/lib/notifications";
import { getPortalActionCounts } from "@/lib/portal";
import { queryOne } from "@/lib/db";
import { PortalHeader } from "./portal-header";
import { resolveAvatarUrl } from "@/lib/storage";

export default async function PortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser(["client"]);
  const [notifications, unread, client, actionCounts] = await Promise.all([
    getNotifications(user.id),
    getUnreadCount(user.id),
    user.clientId
      ? queryOne<{ company_name: string; company_logo_url: string | null }>("SELECT company_name, company_logo_url FROM clients WHERE id = ?", [
          user.clientId,
        ])
      : Promise.resolve(null),
    user.clientId ? getPortalActionCounts(user.clientId) : Promise.resolve({ content: 0, invoices: 0 }),
  ]);

  return (
    <div className="min-h-screen">
      <PortalHeader
        companyName={client?.company_name || "Client Portal"}
        avatarUrl={await resolveAvatarUrl(client?.company_logo_url)}
        notifications={notifications}
        unread={unread}
        actionCounts={actionCounts}
      />
      <main className="animate-fade-up mx-auto max-w-5xl p-4 sm:p-6 lg:p-8">{children}</main>
    </div>
  );
}
