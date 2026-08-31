import * as React from "react";
import { cn } from "@/lib/utils";

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      // See the note in input.tsx: under 16px, iOS zooms the page on focus.
      "flex min-h-20 w-full rounded-md border border-input bg-card px-3 py-2 text-base sm:text-sm text-foreground shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50",
      className
    )}
    {...props}
  />
));
Textarea.displayName = "Textarea";
