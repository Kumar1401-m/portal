import Link from "next/link";
import { ArrowLeft, MessageCircle, Database } from "lucide-react";
import { requireUser, ADMIN_ROLES } from "@/lib/auth";
import { env } from "@/lib/env";
import { getClientsMini } from "@/lib/deliverables";
import {
  approvalsReady,
  getAllGroups,
  getSessionHealth,
  getMessages,
} from "@/lib/whatsapp-approvals";
import { getServiceStatus, getQrCode, listServiceGroups } from "@/lib/whatsapp-service-client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { buttonClasses } from "@/components/ui/button";
import { SessionPanel } from "./session-panel";
import { GroupManager } from "./group-manager";

export const metadata = { title: "WhatsApp · NVK Hub" };
export const dynamic = "force-dynamic";

export default async function WhatsAppSettingsPage() {
  await requireUser(ADMIN_ROLES);

  if (!(await approvalsReady())) {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">WhatsApp approvals</h1>
        <Card>
          <CardContent className="flex items-start gap-3 p-6">
            <Database className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
            <div className="space-y-2">
              <p className="font-medium">The approval tables aren&apos;t set up yet.</p>
              <p className="text-sm text-muted-foreground">
                Run <code className="rounded bg-muted px-1">node database/migrate.js</code>, or
                apply the pending changes from Settings.
              </p>
              <Link href="/settings" className={buttonClasses({ variant: "secondary", size: "sm" })}>
                Open Settings
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // The live service and the stored snapshot are fetched together: the
  // snapshot renders even when the service is down, which is exactly when
  // someone opens this page.
  const [health, linked, clients, status, messages] = await Promise.all([
    getSessionHealth(),
    getAllGroups(),
    getClientsMini(),
    getServiceStatus(),
    getMessages(25),
  ]);

  const serviceReachable = status.ok;
  // Only asked for when a login is actually pending — requesting it while
  // connected returns a 409 by design.
  const qr =
    serviceReachable && status.qrAvailable && !status.connected ? await getQrCode() : null;
  const groups = serviceReachable ? await listServiceGroups() : null;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/settings" className={buttonClasses({ variant: "ghost", size: "icon" })}>
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <MessageCircle className="h-6 w-6 text-primary" />
            WhatsApp approvals
          </h1>
          <p className="text-sm text-muted-foreground">
            Clients approve finished videos in their own WhatsApp group.
          </p>
        </div>
      </div>

      {!env.whatsappService.enabled ? (
        <Card>
          <CardContent className="space-y-2 p-6 text-sm">
            <p className="font-medium">The WhatsApp service isn&apos;t configured.</p>
            <p className="text-muted-foreground">
              Set <code className="rounded bg-muted px-1">WHATSAPP_SERVICE_URL</code>,{" "}
              <code className="rounded bg-muted px-1">WHATSAPP_SERVICE_TOKEN</code> and{" "}
              <code className="rounded bg-muted px-1">WHATSAPP_SERVICE_KEY</code> in this
              portal&apos;s environment, then start the service (see{" "}
              <code className="rounded bg-muted px-1">whatsapp-service/README.md</code>).
            </p>
          </CardContent>
        </Card>
      ) : null}

      <SessionPanel
        snapshot={{
          state: status.ok ? status.state : health?.state || "unknown",
          phoneNumber: (status.ok ? status.me?.number : null) ?? health?.phone_number ?? null,
          pushName: (status.ok ? status.me?.pushName : null) ?? health?.push_name ?? null,
          qrAvailable: status.ok ? status.qrAvailable : Boolean(health?.qr_available),
          lastError: (status.ok ? status.lastError : status.error) ?? health?.last_error ?? null,
          heartbeatAt: health?.heartbeat_at ?? null,
          liveReachable: serviceReachable,
          initialQr: qr?.ok ? qr.dataUrl : null,
        }}
        socketUrl={env.whatsappService.socketUrl || null}
      />

      <GroupManager
        linked={linked}
        available={groups?.ok ? groups.groups : []}
        clients={clients}
        serviceReachable={serviceReachable}
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent group messages</CardTitle>
          <p className="text-xs text-muted-foreground">
            Every message from a linked group, command or not. This is the record when someone
            says they approved something.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          {messages.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">Nothing received yet.</p>
          ) : (
            <div className="max-h-96 overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 border-b border-border bg-muted/60 backdrop-blur">
                  <tr className="text-xs text-muted-foreground">
                    <th className="px-3 py-2 text-left font-medium">When</th>
                    <th className="px-3 py-2 text-left font-medium">Group</th>
                    <th className="px-3 py-2 text-left font-medium">From</th>
                    <th className="px-3 py-2 text-left font-medium">Message</th>
                    <th className="px-3 py-2 text-left font-medium">Read as</th>
                  </tr>
                </thead>
                <tbody>
                  {messages.map((m) => (
                    <tr key={m.id} className="border-b border-border last:border-0">
                      <td className="whitespace-nowrap px-3 py-1.5 text-xs text-muted-foreground">
                        {String(m.message_time).slice(5, 16).replace("T", " ")}
                      </td>
                      <td className="px-3 py-1.5 text-xs">
                        {m.company_name || m.group_name || "—"}
                      </td>
                      <td className="px-3 py-1.5 text-xs">{m.sender_name || "—"}</td>
                      <td className="max-w-[22rem] px-3 py-1.5">
                        <span className="line-clamp-2 text-xs">{m.message}</span>
                      </td>
                      <td className="px-3 py-1.5 text-xs">
                        {m.parsed_command && m.parsed_command !== "none" ? (
                          <span className="font-medium">
                            {m.parsed_command}
                            {m.video_code ? ` ${m.video_code}` : ""}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
