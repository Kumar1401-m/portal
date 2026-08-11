import * as React from "react";
import { cn } from "@/lib/utils";

export function Table({
  className,
  dense,
  ...props
}: React.HTMLAttributes<HTMLTableElement> & {
  /**
   * Tighten the cells so a wide board fits the window.
   *
   * The task boards carry twelve columns, and at the normal 16px of padding
   * each side that is nearly 400px of air — enough to push the table past the
   * viewport and put a horizontal scrollbar under it. A scrollbar is the worst
   * outcome available here: the columns it hides are on the right, which is
   * where Shoot, Video and Actions live, so the parts of a row you act on are
   * the parts that disappear.
   */
  dense?: boolean;
}) {
  return (
    <div className="w-full overflow-x-auto">
      <table
        className={cn(
          "w-full caption-bottom text-sm",
          dense && "[&_td]:px-2 [&_th]:px-2 [&_td]:py-2.5",
          className
        )}
        {...props}
      />
    </div>
  );
}

export function THead({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead
      className={cn(
        "[&_th]:h-11 [&_th]:px-4 [&_th]:text-left [&_th]:align-middle [&_th]:font-medium [&_th]:text-muted-foreground [&_th]:text-xs [&_th]:uppercase [&_th]:tracking-wide",
        className
      )}
      {...props}
    />
  );
}

export function TBody({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn("[&_tr:last-child]:border-0", className)} {...props} />;
}

export function TR({ className, ...props }: React.HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={cn(
        "animate-fade-in border-b border-border transition-colors duration-150 hover:bg-muted/60",
        className
      )}
      {...props}
    />
  );
}

export function TD({ className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn("px-4 py-3 align-middle", className)} {...props} />;
}
