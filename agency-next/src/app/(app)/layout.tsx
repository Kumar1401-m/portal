import { requireUser, STAFF_ROLES } from "@/lib/auth";
import { getNotifications, getUnreadCount } from "@/lib/notifications";
import { AppShell } from "@/components/admin/app-shell";
import { AiAssistant } from "@/components/admin/ai-assistant";
import { suggestionsFor } from "@/lib/assistant";

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
  // What the assistant covers depends on the role, so the chips are chosen
  // server-side alongside the scope its answers will use.
  const scopeLabel =
    user.role === "poster_designer"
      ? "your own tasks"
      : user.role === "crm"
        ? "your assigned clients"
        : "the whole agency";

  return (
    <AppShell user={user} notifications={notifications} unread={unread}>
      {children}
      <AiAssistant
        name={user.name.split(" ")[0]}
        roleLabel={scopeLabel}
        suggestions={suggestionsFor(user.role)}
      />
    </AppShell>
  );
}
