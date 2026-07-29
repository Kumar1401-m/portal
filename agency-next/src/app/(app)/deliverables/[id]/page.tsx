import { getDeliverable } from "@/lib/deliverables";
import { TaskDetail } from "./task-detail";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const d = await getDeliverable(Number(id));
  return { title: d ? `${d.title} · Deliverable` : "Deliverable" };
}

/**
 * The standalone task page. Reached by a fresh load, a refresh or a pasted
 * link — navigating here from inside the portal is intercepted by
 * (app)/@modal/(.)deliverables/[id] and opens as a popup instead.
 */
export default async function DeliverableDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <TaskDetail id={Number(id)} />;
}
