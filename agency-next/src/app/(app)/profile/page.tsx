import { UserCircle } from "lucide-react";
import { requireUser, STAFF_ROLES } from "@/lib/auth";
import { queryOne, hasColumn } from "@/lib/db";
import { resolveAvatarUrl } from "@/lib/storage";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { label } from "@/lib/utils";
import { AvatarForm } from "./avatar-form";

export const metadata = { title: "Your profile · NVK Hub" };
export const dynamic = "force-dynamic";

/**
 * Your own account, and the one thing on it you can change.
 *
 * Reachable by every staff role rather than living in Settings, which is
 * admin-only — an editor or a designer has a face too, and theirs is the one
 * that shows up beside work on other people's boards.
 *
 * Name, email and role are shown and not editable here on purpose: they say
 * who you are to everyone else and who may do what, so they stay with whoever
 * manages the team.
 */
export default async function ProfilePage() {
  const user = await requireUser(STAFF_ROLES);

  // Gated like every other addition: a database that has not run the change
  // yet renders the page and says what is missing.
  const ready = await hasColumn("users", "avatar_url");
  const row = ready
    ? await queryOne<{ avatar_url: string | null }>("SELECT avatar_url FROM users WHERE id = ?", [
        user.id,
      ])
    : null;
  const avatarUrl = await resolveAvatarUrl(row?.avatar_url);

  return (
    <div className="max-w-2xl space-y-5">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <UserCircle className="h-6 w-6 text-primary" />
          Your profile
        </h1>
        <p className="text-sm text-muted-foreground">
          How you appear to the rest of the team.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Profile picture</CardTitle>
        </CardHeader>
        <CardContent>
          {ready ? (
            <AvatarForm name={user.name} initialUrl={avatarUrl} />
          ) : (
            <p className="text-sm text-muted-foreground">
              Profile pictures need one database change that hasn&apos;t been applied yet. A super
              admin can do it from{" "}
              <span className="font-medium text-foreground">Settings → Database</span> — it takes a
              second and touches nothing existing.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Account</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2.5 text-sm">
          {/* Read-only, and it is worth saying why rather than leaving people
              hunting for an edit button that is not there. */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-muted-foreground">Name</span>
            <span className="font-medium">{user.name}</span>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-muted-foreground">Email</span>
            <span className="font-medium">{user.email}</span>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-muted-foreground">Role</span>
            <Badge tone="muted">{label(user.role)}</Badge>
          </div>
          <p className="border-t border-border pt-3 text-xs text-muted-foreground">
            Your name, email and role are managed by a super admin — they decide what you can
            reach, so they are not yours to change here.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
