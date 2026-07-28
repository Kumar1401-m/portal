"use client";

import { useActionState } from "react";
import { KeyRound, Loader2, ShieldCheck, Mail, Send } from "lucide-react";
import { setPortalLogin, resendOnboardingEmail, type PortalState, type ResendState } from "../actions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

export function PortalLogin({
  clientId,
  hasEmail,
  loginEmail,
  loginActive,
}: {
  clientId: number;
  hasEmail: boolean;
  loginEmail: string | null;
  loginActive: number | null;
}) {
  const [state, action, pending] = useActionState<PortalState, FormData>(setPortalLogin, {
    ok: false,
  });
  const [resendState, resendAction, resendPending] = useActionState<ResendState, FormData>(
    resendOnboardingEmail,
    { ok: false }
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound className="h-4 w-4 text-muted-foreground" />
          Portal login
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {loginEmail ? (
          <div className="flex items-center gap-2 text-sm">
            <ShieldCheck className="h-4 w-4 text-success" />
            <span className="text-muted-foreground">{loginEmail}</span>
            <Badge tone={loginActive ? "success" : "muted"}>
              {loginActive ? "Active" : "Disabled"}
            </Badge>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No portal login yet.</p>
        )}

        {hasEmail ? (
          <form action={action} className="space-y-2">
            <input type="hidden" name="id" value={clientId} />
            <div className="flex gap-2">
              <Input
                name="password"
                type="text"
                placeholder={loginEmail ? "New password…" : "Set a password…"}
                autoComplete="off"
              />
              <Button type="submit" variant="secondary" disabled={pending}>
                {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {loginEmail ? "Reset" : "Create"}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">Min 8 characters, with letters and numbers.</p>
            {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
            {state.ok ? <p className="text-sm text-success">Portal login ready ✓</p> : null}
          </form>
        ) : (
          <p className="text-xs text-muted-foreground">Add an email (Edit) to enable a portal login.</p>
        )}

        {hasEmail ? (
          <div className="border-t border-border pt-3">
            <form action={resendAction} className="flex items-center gap-2">
              <input type="hidden" name="id" value={clientId} />
              <Button type="submit" variant="outline" size="sm" disabled={resendPending}>
                {resendPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Mail className="h-4 w-4" />
                )}
                Resend onboarding email
              </Button>
            </form>
            <p className="mt-1.5 flex items-start gap-1 text-xs text-muted-foreground">
              <Send className="mt-0.5 h-3 w-3 shrink-0" />
              {loginEmail
                ? "Issues a fresh portal password and emails it — use this after fixing a wrong address."
                : "Sends the welcome email again (no portal login exists yet)."}
            </p>
            {resendState.error ? (
              <p className="mt-1 text-sm text-destructive">{resendState.error}</p>
            ) : null}
            {resendState.ok ? (
              <p className="mt-1 text-sm text-success">{resendState.message}</p>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
