"use client";

import { useSyncExternalStore } from "react";

/**
 * False while rendering on the server, true once the browser has it.
 *
 * The thing every portal needs to know before calling `createPortal`, because
 * `document.body` does not exist during a server render.
 *
 * The usual way to find out is a `mounted` flag set from an empty effect, and
 * it works — but it is a state update on every first paint, which is what
 * React's own lint rule objects to, and it hides a genuine question behind a
 * boolean that looks like component state. This asks React directly: the
 * server snapshot is false, the client snapshot is true, and nothing ever
 * changes in between, so `subscribe` has nothing to subscribe to.
 */
const noSubscription = () => () => {};
const onTheClient = () => true;
const onTheServer = () => false;

export function useHydrated(): boolean {
  return useSyncExternalStore(noSubscription, onTheClient, onTheServer);
}
