import { NewTaskForm } from "./new-task-form";

export const metadata = { title: "New task · NVK Hub" };
export const dynamic = "force-dynamic";

export default async function NewDeliverablePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; service?: string }>;
}) {
  const sp = await searchParams;
  return <NewTaskForm error={sp.error} service={sp.service} />;
}
