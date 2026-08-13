"use client";

import { useSyncExternalStore } from "react";
import { getGuided, subscribeGuided } from "@/lib/guided";

/**
 * Reactive guided-mode state. The server snapshot is always false, so
 * hydration matches the server HTML; React re-reads the real value (set by the
 * layout's pre-paint bootstrap) immediately after hydration.
 */
export function useGuided(): boolean {
  return useSyncExternalStore(subscribeGuided, getGuided, () => false);
}
