"use client";

import { useState, useTransition } from "react";
import { Check, Database, Loader2, TriangleAlert } from "lucide-react";
import { applySchemaUpdates, type ApplyState } from "./schema-actions";
import type { SchemaColumnStatus } from "@/lib/schema-sync";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { buttonClasses } from "@/components/ui/button";

/**
 * Shows which columns the app expects but the database doesn't have yet, and
 * adds them. Only ever adds — see the note in `schema-sync.ts`.
 */
export function SchemaPanel({ initial }: { initial: SchemaColumnStatus[] }) {
  const [rows, setRows] = useState(initial);
  const [result, setResult] = useState<ApplyState | null>(null);
  const [pending, start] = useTransition();

  const missing = rows.filter((r) => !r.present);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Database className="h-5 w-5 text-muted-foreground" />
          Database updates
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {missing.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-success">
            <Check className="h-4 w-4" />
            The database has everything this version of the portal expects.
          </p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              {missing.length === 1 ? "One column is" : `${missing.length} columns are`} missing.
              The features that need {missing.length === 1 ? "it" : "them"} are switched off until
              {missing.length === 1 ? " it is" : " they are"} added. Adding a column can&apos;t
              affect existing data.
            </p>
            <ul className="space-y-2">
              {missing.map((m) => (
                <li key={`${m.table}.${m.column}`} className="rounded-md border border-border p-3">
                  <p className="font-mono text-xs">
                    {m.table}.{m.column}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{m.purpose}</p>
                </li>
              ))}
            </ul>
            <button
              type="button"
              disabled={pending}
              aria-label="Apply database updates"
              onClick={() =>
                start(async () => {
                  const res = await applySchemaUpdates();
                  setResult(res);
                  if (res.status) setRows(res.status);
                })
              }
              className={buttonClasses()}
            >
              {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Database className="h-4 w-4" />}
              {pending ? "Applying…" : `Add ${missing.length === 1 ? "it" : "them"}`}
            </button>
          </>
        )}

        {result?.added?.length ? (
          <p className="flex items-start gap-2 text-sm text-success">
            <Check className="mt-0.5 h-4 w-4 shrink-0" />
            <span>Added {result.added.join(", ")}.</span>
          </p>
        ) : null}
        {result?.failed?.length ? (
          <div className="space-y-1">
            {result.failed.map((f) => (
              <p key={f.column} className="flex items-start gap-2 text-sm text-destructive">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  {f.column}: {f.error}
                </span>
              </p>
            ))}
          </div>
        ) : null}
        {result?.error ? (
          <p className="flex items-start gap-2 text-sm text-destructive">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{result.error}</span>
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
