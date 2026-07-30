import { RouteModal } from "@/components/ui/route-modal";
import { queryOne } from "@/lib/db";
import { TaskDetail } from "../../../deliverables/[id]/task-detail";

export const dynamic = "force-dynamic";

/**
 * Opening a task from anywhere in the portal — the task list, the dashboard's
 * "Not posted" grid, approvals, a client's page — lands here instead of the
 * full page, so you read the task in a popup without losing your place.
 */
export default async function DeliverableModal({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // Anything that isn't a task id belongs to a sibling route, not to a popup.
  if (!/^\d+$/.test(id)) return null;

  // Just the title, for the header bar. TaskDetail does its own lookup and its
  // own access check; this one is not trusted for either.
  const head = await queryOne<{ title: string }>(
    "SELECT title FROM deliverables WHERE id = ?",
    [Number(id)]
  );

  return (
    <RouteModal title={head?.title ?? "Task"}>
      <TaskDetail id={Number(id)} inModal />
    </RouteModal>
  );
}
