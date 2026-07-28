"use client";

import { useActionState } from "react";
import { Loader2, Upload } from "lucide-react";
import { submitPosterDesign, type PosterState } from "./actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function PosterSubmitForm({
  deliverableId,
  currentLink,
}: {
  deliverableId: number;
  currentLink: string | null;
}) {
  const [state, action, pending] = useActionState<PosterState, FormData>(submitPosterDesign, {
    ok: false,
  });

  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="deliverable_id" value={deliverableId} />
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          name="link"
          type="url"
          placeholder="Paste the design link (Drive/Canva)…"
          defaultValue={currentLink || ""}
          className="flex-1"
        />
        <Button type="submit" disabled={pending}>
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
          {currentLink ? "Update" : "Submit"}
        </Button>
      </div>
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.ok ? <p className="text-sm text-success">Submitted — the admin has been notified ✓</p> : null}
    </form>
  );
}
