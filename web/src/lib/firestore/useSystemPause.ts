"use client";

// Live subscription to the global pause doc. Used by the dashboard banner and
// the PlayScrapeButton so both react the instant any tool trips the kill
// switch — including a pause tripped by a different browser tab.

import { useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { getClientDb } from "@/lib/firebase/client";
import { DEFAULT_PROJECT_ID, paths, type SystemState } from "./schema";

const DEFAULT_STATE: SystemState = {
  paused: false,
  paused_at: null,
  paused_reason: null,
  paused_tool: null,
  paused_kind: null,
};

export function useSystemPause(projectId: string = DEFAULT_PROJECT_ID) {
  const [state, setState] = useState<SystemState>(DEFAULT_STATE);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ref = doc(getClientDb(), paths.systemState(projectId));
    const unsub = onSnapshot(
      ref,
      (snap) => {
        if (!snap.exists()) {
          setState(DEFAULT_STATE);
          setError(null);
          return;
        }
        const data = snap.data() as Partial<SystemState>;
        setState({
          paused: data.paused === true,
          paused_at: typeof data.paused_at === "string" ? data.paused_at : null,
          paused_reason: typeof data.paused_reason === "string" ? data.paused_reason : null,
          paused_tool: typeof data.paused_tool === "string" ? data.paused_tool : null,
          paused_kind: typeof data.paused_kind === "string" ? data.paused_kind : null,
        });
        setError(null);
      },
      (err) => {
        console.error("[useSystemPause] snapshot error", err);
        setError(err.message);
      },
    );
    return () => unsub();
  }, [projectId]);

  return { ...state, error };
}
