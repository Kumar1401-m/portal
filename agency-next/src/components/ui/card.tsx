import * as React from "react";
import { cn } from "@/lib/utils";

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "animate-fade-up rounded-lg border border-border bg-card text-card-foreground shadow-sm",
        "transition-shadow duration-200 hover:shadow-md",
        /*
         * `min-w-0`, or a wide table drags the whole page sideways.
         *
         * A grid or flex child defaults to `min-width: auto`, which means "no
         * narrower than my content". A card holding a nine-column table is
         * therefore 924px wide however small the screen is, the
         * `overflow-x-auto` inside the table never gets the chance to scroll,
         * and the page itself scrolls instead — measured at 868px on a 390px
         * phone, which is the whole layout adrift, header and all.
         *
         * One line here rather than on every grid that ever holds a table: a
         * card that may shrink below its content is what every one of them
         * wants, and the scrolling belongs to the table, not the page.
         */
        "min-w-0",
        className
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-1 p-5", className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3 className={cn("font-semibold leading-none tracking-tight", className)} {...props} />
  );
}

export function CardDescription({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-sm text-muted-foreground", className)} {...props} />;
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-5 pt-0", className)} {...props} />;
}

export function CardFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex items-center p-5 pt-0", className)} {...props} />;
}
