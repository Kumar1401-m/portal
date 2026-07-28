"use client";

import { useActionState } from "react";
import { Upload, CheckCircle2, Loader2 } from "lucide-react";
import { submitRawFootage, type PortalActionState } from "../../actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const INIT: PortalActionState = { ok: false };

/** Shown when a task is waiting on the client's own raw footage before editing can start. */
export function RawFootageForm({ deliverableId }: { deliverableId: number }) {
  const [state, action, pending] = useActionState(submitRawFootage, INIT);

  if (state.ok) {
    return (
      <Card>
        <CardContent className="flex items-center gap-3 p-5 text-success">
          <CheckCircle2 className="h-5 w-5" />
          <p className="text-sm font-medium">{state.message}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Upload className="h-5 w-5 text-muted-foreground" /> Share your raw footage
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          We&apos;re ready to start editing — share a link to your raw video (Google Drive,
          Dropbox, etc.) and we&apos;ll take it from there.
        </p>
        <form action={action} className="space-y-2">
          <input type="hidden" name="deliverable_id" value={deliverableId} />
          <Input name="raw_drive_link" placeholder="https://drive.google.com/…" />
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            Submit footage
          </Button>
          {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
        </form>
      </CardContent>
    </Card>
  );
}
