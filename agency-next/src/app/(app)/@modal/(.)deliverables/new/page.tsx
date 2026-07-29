import { RouteModal } from "@/components/ui/route-modal";
import { NewTaskForm } from "../../../deliverables/new/new-task-form";

export const dynamic = "force-dynamic";

/**
 * "New task" opened from inside the portal.
 *
 * This route has to exist. Its sibling `(.)deliverables/[id]` matches "new" as
 * a task id, so the navigation is intercepted whatever we do — and an
 * intercepted route leaves the page underneath in place, which is why an
 * opt-out here showed the task list with the URL saying /deliverables/new.
 * Owning the route puts the form on screen where it belongs.
 */
export default async function NewTaskModal({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; service?: string }>;
}) {
  const sp = await searchParams;
  return (
    <RouteModal>
      <NewTaskForm error={sp.error} service={sp.service} inModal />
    </RouteModal>
  );
}
