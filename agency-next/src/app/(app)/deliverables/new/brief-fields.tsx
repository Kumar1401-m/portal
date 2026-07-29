"use client";

import { useState } from "react";
import {
  ServiceCategoryPicker,
  type CategoryOptions,
} from "@/components/admin/service-category-picker";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ServiceKey } from "@/lib/services";

/**
 * The service picker plus the brief fields that depend on it.
 *
 * A poster isn't scripted and has no opening hook — it has the copy that goes
 * on it — so picking "Poster Designing" collapses the two video fields into
 * one. `children` carries the server-rendered fields that sit in between, so
 * only the choice itself lives on the client.
 */
export function BriefFields({
  categories,
  defaultService,
  children,
}: {
  categories: CategoryOptions;
  defaultService: ServiceKey;
  children: React.ReactNode;
}) {
  const [service, setService] = useState<ServiceKey>(defaultService);
  const isPoster = service === "poster_designing";

  return (
    <>
      <div className="grid gap-5 sm:grid-cols-2">
        <ServiceCategoryPicker
          categories={categories}
          defaultService={defaultService}
          onServiceChange={setService}
        />
      </div>

      {children}

      {isPoster ? (
        <div className="space-y-1.5">
          <Label htmlFor="description">Content in this poster</Label>
          <Textarea
            id="description"
            name="description"
            rows={4}
            placeholder="The text that goes on the poster — offer, dates, contact details. The AI uses this to write the caption."
          />
        </div>
      ) : (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="description">Description / script</Label>
            <Textarea
              id="description"
              name="description"
              rows={4}
              placeholder="What is this content about? The AI uses this to write the caption."
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="content_hook">Content hook</Label>
            <Input id="content_hook" name="content_hook" placeholder="The opening line / angle" />
          </div>
        </>
      )}
    </>
  );
}
