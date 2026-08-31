import * as React from "react";
import { cn } from "@/lib/utils";

/*
 * `text-base sm:text-sm` is not a style choice.
 *
 * iOS Safari zooms the whole page when a focused input's font is smaller than
 * 16px, and `text-sm` is 14. On a phone that means tapping a field jerks the
 * layout out from under the thumb and leaves the person pinching back out
 * before they can type a character — on the sign-in screen, before they have
 * seen anything else. 16 on a phone, 14 from `sm` up, so the desktop design is
 * untouched.
 */


export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, type = "text", ...props }, ref) => (
  <input
    ref={ref}
    type={type}
    className={cn(
      "flex h-10 w-full rounded-md border border-input bg-card px-3 py-2 text-base sm:text-sm text-foreground shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50",
      className
    )}
    {...props}
  />
));
Input.displayName = "Input";
