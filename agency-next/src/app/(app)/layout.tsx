import { requireUser, STAFF_ROLES } from "@/lib/auth";
import { getNotifications, getUnreadCount } from "@/lib/notifications";
import { AppShell } from "@/components/admin/app-shell";
import { AiAssistant } from "@/components/admin/ai-assistant";
import { ToastProvider } from "@/components/ui/toast";
import { suggestionsFor } from "@/lib/assistant";
import { queryOne, hasColumn } from "@/lib/db";
import { resolveAvatarUrl } from "@/lib/storage";

export default async function AppLayout({
  children,
  modal,
}: {
  children: React.ReactNode;
  /** Intercepted routes that render as a popup over the current page. */
  modal: React.ReactNode;
}) {
  const user = await requireUser(STAFF_ROLES);
  const [notifications, unread, avatarUrl] = await Promise.all([
    getNotifications(user.id),
    getUnreadCount(user.id),
    // Their own picture, for the top bar of every page. Gated because the
    // column is new: a database that has not applied it shows initials as
    // before rather than failing to render the shell everything lives in.
    (async () => {
      if (!(await hasColumn("users", "avatar_url"))) return null;
      const row = await queryOne<{ avatar_url: string | null }>(
        "SELECT avatar_url FROM users WHERE id = ?",
        [user.id]
      );
      return resolveAvatarUrl(row?.avatar_url);
    })(),
  ]);
  // What the assistant covers depends on the role, so the chips are chosen
  // server-side alongside the scope its answers will use.
  const scopeLabel =
    user.role === "poster_designer" || user.role === "video_editor"
      ? "your own tasks"
      : user.role === "crm"
        ? "your assigned clients"
        : "the whole agency";

  return (
    // Outside the shell, so a confirmation survives the modal that raised it
    // closing — which is exactly when one is most needed.
    <ToastProvider>
      <AppShell user={user} notifications={notifications} unread={unread} avatarUrl={avatarUrl}>
        {children}
        {modal}
        <AiAssistant
          name={user.name.split(" ")[0]}
          roleLabel={scopeLabel}
          suggestions={suggestionsFor(user.role)}
        />
      </AppShell>
    </ToastProvider>
  );
}
