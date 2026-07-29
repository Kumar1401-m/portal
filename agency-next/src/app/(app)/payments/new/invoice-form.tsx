"use client";

import { useState } from "react";
import { createInvoice } from "../actions";
import { SubmitButton } from "@/components/ui/submit-button";
import type { ClientMini } from "@/lib/deliverables";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { money } from "@/lib/utils";

export function InvoiceForm({ clients }: { clients: ClientMini[] }) {
  const [amount, setAmount] = useState("");
  const [tax, setTax] = useState("");
  const [fee, setFee] = useState("");

  const total = (Number(amount) || 0) + (Number(tax) || 0) + (Number(fee) || 0);

  return (
    <form action={createInvoice} className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Invoice details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-5 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="client_id">Client *</Label>
              <Select id="client_id" name="client_id" required defaultValue="">
                <option value="" disabled>
                  Select a client…
                </option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.company_name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="due_date">Due date</Label>
              <Input id="due_date" name="due_date" type="date" />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="description">Description</Label>
            <Input id="description" name="description" placeholder="e.g. July social media package" />
          </div>

          <div className="grid gap-5 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="amount">Amount (₹) *</Label>
              <Input
                id="amount"
                name="amount"
                type="number"
                min="0"
                step="1"
                required
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tax">Tax (₹)</Label>
              <Input
                id="tax"
                name="tax"
                type="number"
                min="0"
                step="1"
                value={tax}
                onChange={(e) => setTax(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="processing_fee">Processing fee (₹)</Label>
              <Input
                id="processing_fee"
                name="processing_fee"
                type="number"
                min="0"
                step="1"
                value={fee}
                onChange={(e) => setFee(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="notes">Notes</Label>
            <Textarea id="notes" name="notes" rows={2} />
          </div>

          <div className="flex items-center justify-between rounded-lg bg-muted px-4 py-3">
            <span className="text-sm font-medium text-muted-foreground">Total</span>
            <span className="text-xl font-semibold tabular-nums">{money(total)}</span>
          </div>

          {/* Whether the client hears about this by email is the super admin's
              call — sometimes the invoice is raised here and sent elsewhere. */}
          <label className="flex items-start gap-2.5 rounded-lg border border-border px-4 py-3 text-sm">
            <input
              type="checkbox"
              name="send_email"
              defaultChecked
              className="mt-0.5 h-4 w-4 rounded border-input accent-[var(--primary)]"
            />
            <span>
              <span className="font-medium">Email this invoice to the client</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                Untick to raise the invoice quietly. It still appears in their portal either way.
              </span>
            </span>
          </label>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <SubmitButton pendingLabel="Creating…">Create invoice</SubmitButton>
      </div>
    </form>
  );
}
