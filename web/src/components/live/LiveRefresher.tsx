"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useLiveTopic } from "@/lib/realtime/client";
import { Badge } from "@/components/ui/Badge";
import { Guide } from "@/components/guide/Guide";

/** Coalesce a burst of change events into one refresh this long after the first. */
export const REFRESH_DEBOUNCE_MS = 2_000;

/** Floor between two live refreshes — never hammer the server component. */
export const REFRESH_MIN_INTERVAL_MS = 5_000;

/**
 * Wave-5 live-view island. Subscribes to one or more `mh:*` broadcast topics
 * through the graceful-degradation wrapper and turns DB `change` events into
 * a debounced `router.refresh()`, so the owning server component re-reads its
 * rows with zero page restructuring.
 *
 * Renders a small "Live" badge while the subscription is up and NOTHING
 * otherwise: until the human applies the W5 migration + ALB rule + env, the
 * wrapper reports `unavailable` and the page keeps today's static render and
 * its existing mutation-driven refresh, byte-for-byte unchanged.
 */
export function LiveRefresher({
  topic,
}: {
  /** One topic or several; DB triggers broadcast the `change` event on each. */
  topic: string | readonly string[];
}) {
  const router = useRouter();
  /** The one pending debounced refresh (at most one is ever scheduled). */
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRefreshAt = useRef(Number.NEGATIVE_INFINITY);

  // Unmount: cancel any scheduled refresh so nothing fires afterwards.
  useEffect(
    () => () => {
      if (pending.current !== null) clearTimeout(pending.current);
      pending.current = null;
    },
    [],
  );

  const status = useLiveTopic(topic, {
    onEvent: () => {
      if (pending.current !== null) return; // burst -> the one pending refresh
      const wait = Math.max(
        REFRESH_DEBOUNCE_MS,
        lastRefreshAt.current + REFRESH_MIN_INTERVAL_MS - Date.now(),
      );
      pending.current = setTimeout(() => {
        pending.current = null;
        lastRefreshAt.current = Date.now();
        router.refresh();
      }, wait);
    },
  });

  if (status !== "live") return null;
  return (
    <Guide id="overview.live.badge">
      <Badge
        tone="var(--data-3)"
        title="Realtime connected — this view refreshes itself"
      >
        Live
      </Badge>
    </Guide>
  );
}

export default LiveRefresher;
