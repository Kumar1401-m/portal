"use client";

/**
 * "Which client?", on any page that has more than one answer.
 *
 * Lifted out of the analytics page, which had it hardcoded to `/analytics` and
 * to that page's one other query param. The leads board needs exactly the same
 * control and would otherwise have got a second copy of it — and a second copy
 * is how the two of them end up disagreeing about what "All clients" means.
 *
 * Whatever else is in the URL travels with the choice. Picking a client on the
 * leads board while filtered to "proposal" keeps that filter, because losing it
 * would look like the client has no leads at that stage.
 */
import { useRouter } from "next/navigation";
import { Select } from "@/components/ui/select";

export function ClientFilter({
  clients,
  current,
  basePath,
  keep = {},
  label = "All clients",
}: {
  clients: { id: number; company_name: string }[];
  current: number | null;
  /** Where the choice navigates to, e.g. "/leads". */
  basePath: string;
  /** Other query params to carry across, dropped when empty. */
  keep?: Record<string, string | undefined | null>;
  /** What the empty option reads as. */
  label?: string;
}) {
  const router = useRouter();
  return (
    <Select
      aria-label="Client"
      value={current ? String(current) : ""}
      onChange={(e) => {
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(keep)) if (v) params.set(k, v);
        if (e.target.value) params.set("client", e.target.value);
        const qs = params.toString();
        router.push(qs ? `${basePath}?${qs}` : basePath, { scroll: false });
      }}
      className="h-9 w-44 text-sm"
    >
      <option value="">{label}</option>
      {clients.map((c) => (
        <option key={c.id} value={c.id}>
          {c.company_name}
        </option>
      ))}
    </Select>
  );
}
