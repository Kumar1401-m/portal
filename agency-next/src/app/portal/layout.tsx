import { requireUser } from "@/lib/auth";
import { getNotifications, getUnreadCount } from "@/lib/notifications";
import { queryOne } from "@/lib/db";
import { PortalHeader } from "./portal-header";

export default async function PortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser(["client"]);
  const [notifications, unread, client] = await Promise.all([
    getNotifications(user.id),
    getUnreadCount(user.id),
    user.clientId
      ? queryOne<{ company_name: string }>("SELECT company_name FROM clients WHERE id = ?", [
          user.clientId,
        ])
      : Promise.resolve(null),
  ]);

  return (
    <div className="min-h-screen">
      <PortalHeader
        companyName={client?.company_name || "Client Portal"}
        notifications={notifications}
        unread={unread}
      />
      <main className="mx-auto max-w-5xl p-4 sm:p-6 lg:p-8">{children}</main>
    </div>
  );
}
