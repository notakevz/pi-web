"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import {
  createSessionViewPrefetchController,
  type BackgroundSessionRefreshInputs,
  type SessionViewPrefetchController,
} from "@/lib/session-view-prefetch";
import {
  deleteSessionViewSnapshot,
  getSessionViewSnapshot,
  peekSessionViewSnapshot,
  setSessionViewSnapshot,
} from "@/lib/session-view-cache";

/**
 * AppShell supplies its existing catalog and 2.5 s running poll. This hook never
 * polls /running, updates UI state, or starts a session. Hidden/offline tabs abort
 * and pause; visibility/online wakes retain bounded pending completion reads.
 */
export function useBackgroundSessionRefresh(inputs: BackgroundSessionRefreshInputs): void {
  const controller = useRef<SessionViewPrefetchController | null>(null);
  const { sessions, runningSessionIds, selectedSessionId } = inputs;

  // Selection guards update during the commit, before an awaited response can
  // write to the cache. Construction is side-effect-free; lifecycle is below.
  useLayoutEffect(() => {
    if (!controller.current) {
      controller.current = createSessionViewPrefetchController({
        fetch: (url, init) => fetch(url, init),
        cache: {
          peek: peekSessionViewSnapshot,
          set: setSessionViewSnapshot,
          delete: deleteSessionViewSnapshot,
          protect: (id) => { getSessionViewSnapshot(id); },
        },
      });
    }
    controller.current.update({ sessions, runningSessionIds, selectedSessionId });
  }, [sessions, runningSessionIds, selectedSessionId]);

  useEffect(() => {
    const current = controller.current!;
    const reconcileEnvironment = () => current.setEnvironment({
      visible: document.visibilityState !== "hidden",
      online: navigator.onLine !== false,
    });
    reconcileEnvironment();
    current.start();
    document.addEventListener("visibilitychange", reconcileEnvironment);
    window.addEventListener("online", reconcileEnvironment);
    window.addEventListener("offline", reconcileEnvironment);
    return () => {
      current.stop();
      document.removeEventListener("visibilitychange", reconcileEnvironment);
      window.removeEventListener("online", reconcileEnvironment);
      window.removeEventListener("offline", reconcileEnvironment);
    };
  }, []);
}
