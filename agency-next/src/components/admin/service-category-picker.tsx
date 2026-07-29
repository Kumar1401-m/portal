"use client";

import { useState } from "react";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { SERVICE_LIST, SERVICES, isServiceKey, type ServiceKey } from "@/lib/services";
import { cn } from "@/lib/utils";

/** Client-safe shape of the admin-managed category list. */
export type CategoryOptions = Record<ServiceKey, { id: number; name: string }[]>;

/**
 * Paired Service → Category selects. Every task must belong to a service and a
 * category, and the category list swaps to match the chosen service.
 */
export function ServiceCategoryPicker({
  categories,
  defaultService = "video_editing",
  defaultCategory = "",
  idPrefix = "",
  required = true,
  onServiceChange,
}: {
  categories: CategoryOptions;
  defaultService?: ServiceKey;
  defaultCategory?: string;
  idPrefix?: string;
  required?: boolean;
  /** Lets the surrounding form adapt — poster briefs ask for different fields. */
  onServiceChange?: (service: ServiceKey) => void;
}) {
  const [service, setService] = useState<ServiceKey>(defaultService);
  const [category, setCategory] = useState(defaultCategory);

  const options = categories[service] ?? [];
  // A task tagged before a rename (or moved between services) keeps its old
  // value visible rather than silently reverting to blank.
  const orphan = category && !options.some((o) => o.name === category) ? category : null;

  const sid = `${idPrefix}service`;
  const cid = `${idPrefix}category`;

  return (
    <>
      <div className="space-y-1.5">
        <Label htmlFor={sid}>Service {required ? "*" : ""}</Label>
        <Select
          id={sid}
          name="service"
          value={service}
          required={required}
          onChange={(e) => {
            const next = e.target.value;
            if (isServiceKey(next)) {
              setService(next);
              setCategory(""); // categories are service-specific
              onServiceChange?.(next);
            }
          }}
        >
          {SERVICE_LIST.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </Select>
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className={cn("h-2 w-2 rounded-full", SERVICES[service].dot)} />
          Colour-coded as {SERVICES[service].color} across the portal.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={cid}>Category {required ? "*" : ""}</Label>
        <Select
          id={cid}
          name="content_category"
          value={category}
          required={required}
          onChange={(e) => setCategory(e.target.value)}
        >
          <option value="" disabled>
            Select a category…
          </option>
          {orphan ? <option value={orphan}>{orphan}</option> : null}
          {options.map((o) => (
            <option key={o.id} value={o.name}>
              {o.name}
            </option>
          ))}
        </Select>
        <p className="text-xs text-muted-foreground">
          Manage this list in Settings → Task categories.
        </p>
      </div>
    </>
  );
}
