"use client";

/**
 * Live approval updates over Socket.IO.
 *
 * The socket connects to the WhatsApp service, not to the portal. The portal
 * runs on Vercel, where a function is torn down between requests and cannot
 * hold a WebSocket open; the service is long-lived by necessity, so it hosts
 * the realtime hub and the dashboard joins as a client.
 *
 * Degrades rather than breaks. With no socket URL configured, or the service
 * down, the hook reports `connected: false` and the page simply behaves like a
 * normal server-rendered dashboard — refresh to see changes.
 */
import { useEffect, useRef, useState, useCallback } from "react";
import { io, type Socket } from "socket.io-client";

export type VideoUpdate = {
  videoCode?: string | null;
  deliverableId?: number | null;
  /**
   * WhatsApp's own id for the message we sent.
   *
   * Delivery receipts arrive from WhatsApp carrying nothing but this — the
   * service has no database and cannot say which video it belongs to, so the
   * portal matches it against the id it stored when the video was sent.
   */
  waMessageId?: string | null;
  waStatus?: string;
  status?: string;
  approvedBy?: string | null;
  comment?: string | null;
  error?: string | null;
  at?: string;
};

export type WhatsAppStatus = {
  state: string;
  connected: boolean;
  qrAvailable: boolean;
  me?: { number: string | null; pushName: string | null } | null;
  lastError?: string | null;
};

type Options = {
  /** Fired on every approval/send change. */
  onVideoUpdate?: (update: VideoUpdate) => void;
  /** Fired when the WhatsApp session's own state changes. */
  onStatus?: (status: WhatsAppStatus) => void;
  onQr?: (dataUrl: string) => void;
};

export function useWhatsAppSocket(socketUrl: string | null | undefined, options: Options = {}) {
  const [connected, setConnected] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<VideoUpdate | null>(null);
  const [status, setStatus] = useState<WhatsAppStatus | null>(null);

  // Handlers live in a ref so a parent re-render doesn't tear down and rebuild
  // the socket — reconnect storms are the classic bug in this pattern.
  //
  // Written in an effect rather than during render: a ref mutation during
  // render is not safe under concurrent rendering, where a render can be
  // discarded and replayed.
  const handlers = useRef(options);
  useEffect(() => {
    handlers.current = options;
  });

  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    if (!socketUrl) return;

    const socket = io(socketUrl, {
      path: "/socket.io",
      // Polling first, then upgrade. Some corporate proxies block a bare
      // WebSocket upgrade, and failing closed there would silently disable
      // realtime for exactly the offices most likely to use it.
      transports: ["polling", "websocket"],
      reconnection: true,
      reconnectionDelay: 2000,
      reconnectionDelayMax: 30_000,
      timeout: 10_000,
      withCredentials: true,
    });
    socketRef.current = socket;

    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));
    socket.on("connect_error", () => setConnected(false));

    /*
     * Delivery receipts — sent, delivered, read.
     *
     * A separate event from the service, and one nothing was listening for, so
     * a video sat on "queued" in the board until the page was reloaded even
     * though the database had it right all along. Normalised into the same
     * shape as an approval update so the board has one path to handle, and
     * "read" is renamed to "viewed" here because that is the word the portal
     * stores and shows — two names for one state is how a live view and a
     * refreshed one come to disagree.
     */
    socket.on("videoDelivery", ({ waMessageId, status }: { waMessageId?: string; status?: string }) => {
      if (!waMessageId || !status) return;
      handlers.current.onVideoUpdate?.({
        waMessageId,
        waStatus: status === "read" ? "viewed" : status,
      });
    });

    socket.on("videoUpdated", (update: VideoUpdate) => {
      setLastUpdate(update);
      handlers.current.onVideoUpdate?.(update);
    });

    socket.on("whatsappStatus", (s: WhatsAppStatus) => {
      setStatus(s);
      handlers.current.onStatus?.(s);
    });

    socket.on("whatsappQr", ({ dataUrl }: { dataUrl: string }) => {
      handlers.current.onQr?.(dataUrl);
    });

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [socketUrl]);

  /** Manual refresh, for the "reconnect" button and error recovery. */
  const reconnect = useCallback(() => {
    socketRef.current?.connect();
  }, []);

  return { connected, lastUpdate, status, reconnect };
}
