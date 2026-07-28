"use client";

import { useState } from "react";
import { EyeOff, Eye, Pencil, X } from "lucide-react";
import { addCategory, renameCategory, toggleCategory } from "./actions";
import { ActionForm } from "./action-form";
import { Input } from "@/components/ui/input";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SERVICE_LIST, type ServiceKey } from "@/lib/services";
import { cn } from "@/lib/utils";

export type ManagedCategory = {
  id: number;
  service: ServiceKey;
  name: string;
  is_active: number;
};

/**
 * Settings → Task categories. Admins add, rename and retire the category list
 * behind every service; new tasks pick from whatever is active here.
 */
export function CategoryManager({
  categories,
}: {
  categories: Record<ServiceKey, ManagedCategory[]>;
}) {
  const [openService, setOpenService] = useState<ServiceKey>("video_editing");
  const [editing, setEditing] = useState<number | null>(null);

  const rows = categories[openService] ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Task categories</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <p className="text-sm text-muted-foreground">
          Every task belongs to a service and one of its categories. Hidden
          categories stay on existing tasks but disappear from the new-task form.
        </p>

        {/* Service picker */}
        <div className="flex flex-wrap gap-1.5">
          {SERVICE_LIST.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => {
                setOpenService(s.key);
                setEditing(null);
              }}
              className={cn(
                "inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium transition-colors",
                openService === s.key
                  ? s.tab
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              <span className={cn("h-2 w-2 rounded-full", s.dot)} />
              {s.short}
              <span className="text-xs tabular-nums opacity-70">
                {(categories[s.key] ?? []).filter((c) => c.is_active).length}
              </span>
            </button>
          ))}
        </div>

        {/* Existing categories */}
        <ul className="divide-y divide-border rounded-lg border border-border">
          {rows.length === 0 ? (
            <li className="p-4 text-sm text-muted-foreground">
              No categories yet for this service — add the first one below.
            </li>
          ) : (
            rows.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-2 p-3">
                {editing === c.id ? (
                  <ActionForm
                    action={renameCategory}
                    submitLabel="Save"
                    size="sm"
                    variant="secondary"
                    className="flex-1"
                    formClassName="flex flex-wrap items-center gap-2"
                  >
                    <input type="hidden" name="id" value={c.id} />
                    <Input
                      name="name"
                      defaultValue={c.name}
                      autoFocus
                      className="h-9 max-w-xs flex-1"
                    />
                  </ActionForm>
                ) : (
                  <span
                    className={cn(
                      "flex-1 text-sm",
                      c.is_active ? "" : "text-muted-foreground line-through"
                    )}
                  >
                    {c.name}
                  </span>
                )}

                <div className="flex items-center gap-1">
                  {editing === c.id ? (
                    <button
                      type="button"
                      onClick={() => setEditing(null)}
                      title="Cancel"
                      className={buttonClasses({ variant: "ghost", size: "icon" })}
                    >
                      <X className="h-4 w-4" />
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setEditing(c.id)}
                      title="Rename"
                      className={buttonClasses({ variant: "ghost", size: "icon" })}
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                  )}
                  <ActionForm
                    action={toggleCategory}
                    submitLabel={c.is_active ? "Hide" : "Show"}
                    size="sm"
                    variant="ghost"
                    formClassName="flex items-center"
                  >
                    <input type="hidden" name="id" value={c.id} />
                    {c.is_active ? (
                      <EyeOff className="mr-1 h-4 w-4" />
                    ) : (
                      <Eye className="mr-1 h-4 w-4" />
                    )}
                  </ActionForm>
                </div>
              </li>
            ))
          )}
        </ul>

        {/* Add a new one */}
        <ActionForm
          action={addCategory}
          submitLabel="Add category"
          resetOnSuccess
          formClassName="flex flex-wrap items-end gap-2"
        >
          <input type="hidden" name="service" value={openService} />
          <div className="min-w-48 flex-1">
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              New category for {SERVICE_LIST.find((s) => s.key === openService)?.label}
            </label>
            <Input name="name" placeholder="e.g. Behind-the-scenes Reel" />
          </div>
        </ActionForm>
      </CardContent>
    </Card>
  );
}
