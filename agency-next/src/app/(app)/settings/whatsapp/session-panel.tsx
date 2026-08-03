"use client";

import { useActionState, useEffect, useState } from "react";
import Image from "next/image";
import { Loader2, RefreshCw, Wifi, WifiOff, QrCode, TriangleAlert, Check } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { reconnectWhatsAppAction, type GroupState } from "../../approvals/whatsapp-actions";
import { useWhatsAppSocket } from "@/components/admin/use-whatsapp-socket";

export type SessionSnapshot = {
  state: string;
  phoneNumber: string | null;
  pushName: string | null;
  qrAvailable: boolean;
  lastError: string | null;
  heartbeatAt: string | null;
  /** From the live service when reachable; null when it isn't. */
  liveReachable: boolean;
  initialQr: string | null;
};

const STATE_LABEL: Record<string, { text: string; tone: "success" | "warning" | "danger" | "muted" }> = {
  connected: { text: "Connected", tone: "success" },
  authenticating: { text: "Authenticating", tone: "warning" },
  qr_required: { text: "Waiting for QR scan", tone: "warning" },
  booting: { text: "Starting", tone: "muted" },
  disconnected: { text: "Disconnected", tone: "danger" },
  failed: { text: "Failed", tone: "danger" },
  unknown: { text: "Unknown", tone: "muted" },
};

/** How stale a heartbeat has to be before the service is presumed dead. */
const STALE_AFTER_MS = 5 * 60 * 1000;

/**
 * WhatsApp session health, with the QR code when a login is needed.
 *
 * Two sources, deliberately. The database snapshot renders instantly and works
 * even when the service is unreachable; the socket then takes over for live
 * changes. Relying on the socket alone would leave this page blank in exactly
 * the situation it exists for — the service being down.
 */
export function SessionPanel({
  snapshot,
  socketUrl,
}: {
  snapshot: SessionSnapshot;
  socketUrl: string | null;
}) {
  const [state, setState] = useState(snapshot.state);
  const [qr, setQr] = useState<string | null>(snapshot.initialQr);
  const [me, setMe] = useState<{ number: string | null; pushName: string | null } | null>(
    snapshot.phoneNumber ? { number: snapshot.phoneNumber, pushName: snapshot.pushName } : null
  );

  const [action, formAction, pending] = useActionState<GroupState, FormData>(
    reconnectWhatsAppAction,
    { ok: false }
  );

  const { connected: socketConnected } = useWhatsAppSocket(socketUrl, {
    onStatus: (s) => {
      setState(s.state);
      if (s.me) setMe(s.me);
      // Once connected the QR is meaningless — clear it so a stale code isn't
      // left on screen inviting someone to scan an expired login.
      if (s.connected) setQr(null);
    },
    onQr: (dataUrl) => setQr(dataUrl),
  });

  /*
   * A heartbeat older than a few minutes means the service process is gone,
   * which looks identical to "idle" unless it's called out.
   *
   * Evaluated on the client only, and re-checked on a timer. Computing it
   * during render would compare the server's clock on the first pass and the
   * browser's on the second — a hydration mismatch — and computing it once
   * would leave a page left open showing "healthy" long after the service died.
   */
  const [stale, setStale] = useState(false);
  useEffect(() => {
    const check = () => {
      if (!snapshot.heartbeatAt) {
        setStale(true);
        return;
      }
      const beat = new Date(
        snapshot.heartbeatAt.replace(" ", "T") + (snapshot.heartbeatAt.includes("Z") ? "" : "Z")
      ).getTime();
      setStale(Number.isNaN(beat) || Date.now() - beat > STALE_AFTER_MS);
    };

    // Deferred so the first evaluation happens after hydration, not during it.
    const initial = setTimeout(check, 0);
    const interval = setInterval(check, 30_000);
    return () => {
      clearTimeout(initial);
      clearInterval(interval);
    };
  }, [snapshot.heartbeatAt]);

  const label = STATE_LABEL[state] ?? STATE_LABEL.unknown;
  const isConnected = state === "connected";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            {isConnected ? (
              <Wifi className="h-5 w-5 text-success" />
            ) : (
              <WifiOff className="h-5 w-5 text-muted-foreground" />
            )}
            WhatsApp session
          </span>
          <Badge tone={label.tone}>{label.text}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {!snapshot.liveReachable ? (
          <p className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2.5 text-destructive">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Can&apos;t reach the WhatsApp service. Check it&apos;s running
              (<code className="rounded bg-muted px-1">docker compose ps</code>) and that
              WHATSAPP_SERVICE_URL points at it.
            </span>
          </p>
        ) : stale ? (
          <p className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 p-2.5 text-warning">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              No heartbeat for over five minutes — the service may have stopped, even though the
              status above still reads {label.text.toLowerCase()}.
            </span>
          </p>
        ) : null}

        {isConnected && me ? (
          <div className="rounded-md border border-border bg-muted/40 p-3">
            <p className="text-xs text-muted-foreground">Logged in as</p>
            <p className="font-medium">
              {me.pushName || "WhatsApp account"}{" "}
              {me.number ? <span className="text-muted-foreground">+{me.number}</span> : null}
            </p>
          </div>
        ) : null}

        {qr && !isConnected ? (
          <div className="space-y-2">
            <p className="flex items-center gap-2 font-medium">
              <QrCode className="h-4 w-4" /> Scan to log in
            </p>
            <ol className="ml-4 list-decimal space-y-0.5 text-xs text-muted-foreground">
              <li>Open WhatsApp on the phone that will send approvals</li>
              <li>Settings → Linked devices → Link a device</li>
              <li>Scan the code below</li>
            </ol>
            {/* Unoptimised: this is a runtime-generated data URL, so Next's
                image pipeline has nothing to cache or resize. */}
            <Image
              src={qr}
              alt="WhatsApp login QR code"
              width={280}
              height={280}
              unoptimized
              className="rounded-lg border border-border bg-white p-2"
            />
            <p className="text-xs text-muted-foreground">
              The code expires after about a minute. If it stops working, press Reconnect for a
              fresh one.
            </p>
          </div>
        ) : null}

        {snapshot.lastError && !isConnected ? (
          <p className="text-xs text-destructive">{snapshot.lastError}</p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <form action={formAction}>
            <button
              type="submit"
              disabled={pending}
              className={buttonClasses({ variant: "secondary", size: "sm" })}
            >
              {pending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              {pending ? "Reconnecting…" : "Reconnect"}
            </button>
          </form>
          <span className="text-xs text-muted-foreground">
            {socketConnected ? "Live updates on" : "Live updates off — refresh to see changes"}
          </span>
        </div>

        {action.error ? (
          <p className="flex items-start gap-2 text-xs text-destructive">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{action.error}</span>
          </p>
        ) : null}
        {action.ok && action.message ? (
          <p className="flex items-start gap-2 text-xs text-success">
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{action.message}</span>
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
