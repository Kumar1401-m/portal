"use client";

import { useFormStatus } from "react-dom";
import { Loader2 } from "lucide-react";
import { Button, type ButtonProps } from "./button";

/**
 * A submit button that disables itself while its form is in flight.
 *
 * Plain server-action forms happily fire twice on a double-click, which on a
 * create form means two identical records. Anything that inserts should use
 * this rather than a bare <Button type="submit">.
 */
export function SubmitButton({
  children,
  pendingLabel,
  ...props
}: ButtonProps & { pendingLabel?: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} {...props}>
      {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
      {pending ? (pendingLabel ?? "Saving…") : children}
    </Button>
  );
}
