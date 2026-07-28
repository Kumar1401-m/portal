import { Hammer } from "lucide-react";
import { Card } from "@/components/ui/card";

export function ComingSoon({
  title,
  note,
}: {
  title: string;
  note?: string;
}) {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <Card className="flex flex-col items-center justify-center gap-3 p-12 text-center">
        <div className="grid h-14 w-14 place-items-center rounded-2xl bg-accent text-accent-foreground">
          <Hammer className="h-7 w-7" />
        </div>
        <p className="text-lg font-medium">This module is being rebuilt in React.</p>
        <p className="max-w-md text-sm text-muted-foreground">
          {note ||
            "It works in the current portal — we're porting it into the new Next.js app next."}
        </p>
      </Card>
    </div>
  );
}
