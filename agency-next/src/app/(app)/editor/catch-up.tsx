"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { advanceStalledAnalyses } from "./actions";

/**
 * Quietly finishes captions that were left mid-flight.
 *
 * An upload drives its own caption from the browser that started it, so
 * closing the tab halfway leaves the job parked. The scheduled catch-up
 * collects those, but only once a day on this hosting plan — long enough that
 * an editor would reasonably conclude the feature was broken.
 *
 * This page is the right place to make up the difference: it is where videos
 * waiting on something are listed, so it is where a stuck one gets noticed.
 * Renders nothing, blocks nothing, and refreshes only if it actually moved
 * something — a refresh that changes no pixels is just a flicker.
 */
export function CaptionCatchUp() {
  const router = useRouter();
  // Effects run twice in development; the work is idempotent but the second
  // call is pure waste, and a lease means it would mostly no-op anyway.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    advanceStalledAnalyses()
      .then(({ advanced }) => {
        if (advanced > 0) router.refresh();
      })
      .catch(() => {
        // Best-effort by design: the daily job will get to it.
      });
  }, [router]);

  return null;
}
