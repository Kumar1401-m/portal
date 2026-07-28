"use client";

import { useActionState, useEffect, useRef } from "react";
import { Loader2, Check, AlertCircle } from "lucide-react";
import type { ActionState } from "./actions";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Wraps a settings server action with pending state and inline success/error
 * feedback, so every panel on this page behaves the same way.
 */
export function ActionForm({
  action,
  submitLabel,
  children,
  className,
  formClassName,
  resetOnSuccess = false,
  size = "md",
  variant = "default",
  confirm,
}: {
  action: (prev: ActionState, fd: FormData) => Promise<ActionState>;
  submitLabel: string;
  children?: React.ReactNode;
  className?: string;
  formClassName?: string;
  resetOnSuccess?: boolean;
  size?: "sm" | "md";
  variant?: "default" | "secondary" | "outline" | "ghost" | "destructive";
  confirm?: string;
}) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(action, {
    ok: false,
  });
  const ref = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.ok && resetOnSuccess) ref.current?.reset();
  }, [state, resetOnSuccess]);

  return (
    <div className={className}>
      <form
        ref={ref}
        action={formAction}
        className={formClassName}
        onSubmit={(e) => {
          if (confirm && !window.confirm(confirm)) e.preventDefault();
        }}
      >
        {children}
        <Button type="submit" disabled={pending} size={size} variant={variant}>
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {submitLabel}
        </Button>
      </form>

      {state.error || state.message ? (
        <p
          className={cn(
            "mt-3 flex items-start gap-1.5 text-sm",
            state.error ? "text-destructive" : "text-success"
          )}
        >
          {state.error ? (
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          ) : (
            <Check className="mt-0.5 h-4 w-4 shrink-0" />
          )}
          {state.error || state.message}
        </p>
      ) : null}
    </div>
  );
}
