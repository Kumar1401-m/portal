import { RouteModal } from "@/components/ui/route-modal";
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
  return (
    <RouteModal>
      <TaskDetail id={Number(id)} inModal />
    </RouteModal>
  );
}
