import { requireUser, STAFF_ROLES } from "@/lib/auth";
import { getNotifications, getUnreadCount } from "@/lib/notifications";
import { AppShell } from "@/components/admin/app-shell";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser(STAFF_ROLES);
  const [notifications, unread] = await Promise.all([
    getNotifications(user.id),
    getUnreadCount(user.id),
  ]);
  return (
    <AppShell user={user} notifications={notifications} unread={unread}>
      {children}
    </AppShell>
  );
}
