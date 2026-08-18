"use client";

import { useRouter } from "next/navigation";
import { Select } from "@/components/ui/select";

/**
 * Whose ads you are looking at.
 *
 * The board already reached a client's own page — every row in "By client" is
 * a link to it — but only for a client who spent something in the range you
 * happen to be on. A client who paused their ads last month was reachable
 * from no range that showed them, which is exactly when somebody goes looking.
 *
 * Lists every client, therefore, not just the spenders. "All clients" is the
 * way back, so this is a place you can move around from rather than a door
 * that only opens one way.
 *
 * The range travels with the choice. Switching client while looking at "This
 * year" and landing on "This month" would be the page quietly answering a
 * different question from the one asked.
 */
export function ClientPicker({
  clients,
  current,
  range,
}: {
  clients: { id: number; company_name: string }[];
  /** The client being shown, or null on the whole-book board. */
  current?: number | null;
  range: string;
}) {
  const router = useRouter();
  return (
    <Select
      aria-label="Client"
      value={current ? String(current) : ""}
      onChange={(e) => {
        const v = e.target.value;
        router.push(v ? `/ads/${v}?range=${range}` : `/ads?range=${range}`, { scroll: false });
      }}
      className="h-9 w-48 text-sm"
    >
      <option value="">All clients</option>
      {clients.map((c) => (
        <option key={c.id} value={c.id}>
          {c.company_name}
        </option>
      ))}
    </Select>
  );
}
