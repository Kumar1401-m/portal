"use client";

import { useRouter } from "next/navigation";
import { Select } from "@/components/ui/select";

/**
 * Whose content the studio is writing.
 *
 * Everything the five tools produce is grounded in one client's brand
 * knowledge and one client's performance history, so the studio cannot open
 * on "nobody" — the picker is the first thing on the page and changing it
 * reloads the tools against the account they now belong to.
 */
export function StudioClientPicker({
  clients,
  current,
}: {
  clients: { id: number; company_name: string }[];
  current: number | null;
}) {
  const router = useRouter();
  return (
    <Select
      aria-label="Client"
      value={current ? String(current) : ""}
      onChange={(e) => {
        const v = e.target.value;
        router.push(v ? `/studio?client=${v}` : "/studio", { scroll: false });
      }}
      className="h-9 w-56 text-sm"
    >
      <option value="">Choose a client…</option>
      {clients.map((c) => (
        <option key={c.id} value={c.id}>
          {c.company_name}
        </option>
      ))}
    </Select>
  );
}
