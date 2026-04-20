"use client";

// Collection-group subscription over ALL steps in the project, ordered by
// started_at desc, capped at the most recent N. Powers both the dashboard's
// live log pane and the "currently running" overlay on the heatmap (which
// cells should pulse orange). Requires a Firestore composite index on the
// `steps` collection group: project_id ASC + started_at DESC.

import { useEffect, useMemo, useState } from "react";
import {
  collectionGroup,
  limit,
  onSnapshot,
  orderBy,
  query,
  where,
  type DocumentData,
  type QuerySnapshot,
} from "firebase/firestore";
import { getClientDb } from "@/lib/firebase/client";
import { Step, DEFAULT_PROJECT_ID } from "./schema";

const DEFAULT_LIMIT = 500;
const THROUGHPUT_WINDOW_MS = 60_000;

function parseStep(raw: DocumentData & { id: string }): Step | null {
  const parsed = Step.safeParse(raw);
  if (parsed.success) return parsed.data;
  console.warn("[useLiveSteps] parse failed", raw.id, parsed.error.issues);
  return null;
}

export type LiveStepsResult = {
  steps: Step[];
  runningRowIds: Set<string>;
  completionsLast60s: number;
  loading: boolean;
  error: string | null;
  version: number;
};

export function useLiveSteps(
  projectId: string = DEFAULT_PROJECT_ID,
  max: number = DEFAULT_LIMIT,
): LiveStepsResult {
  const [steps, setSteps] = useState<Step[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  useEffect(() => {
    setLoading(true);
    setError(null);
    const db = getClientDb();
    const q = query(
      collectionGroup(db, "steps"),
      where("project_id", "==", projectId),
      orderBy("started_at", "desc"),
      limit(max),
    );
    const unsub = onSnapshot(
      q,
      (snap: QuerySnapshot) => {
        const out: Step[] = [];
        snap.forEach((doc) => {
          const s = parseStep({ id: doc.id, ...doc.data() });
          if (s) out.push(s);
        });
        setSteps(out);
        setLoading(false);
        setVersion((v) => v + 1);
      },
      (err) => {
        console.error("[useLiveSteps] snapshot error", err);
        setError(err.message);
        setLoading(false);
      },
    );
    return () => unsub();
  }, [projectId, max]);

  // Tick once per second so completionsLast60s recomputes as time slides.
  // onSnapshot fires when *data* changes, not when clock advances.
  useEffect(() => {
    const id = setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const { runningRowIds, completionsLast60s } = useMemo(() => {
    const running = new Set<string>();
    const byRow = new Map<string, { latestIdx: number; latestStatus: string }>();
    for (const s of steps) {
      const prev = byRow.get(s.row_id);
      if (!prev || s.idx > prev.latestIdx) {
        byRow.set(s.row_id, { latestIdx: s.idx, latestStatus: s.status });
      }
    }
    for (const [rowId, info] of byRow) {
      if (info.latestStatus === "running") running.add(rowId);
    }
    const cutoff = nowMs - THROUGHPUT_WINDOW_MS;
    let completions = 0;
    for (const s of steps) {
      if (s.status !== "done" && s.status !== "skipped") continue;
      const t = s.finished_at ?? s.started_at;
      const ms = Date.parse(t);
      if (Number.isFinite(ms) && ms >= cutoff) completions += 1;
    }
    return { runningRowIds: running, completionsLast60s: completions };
  }, [steps, nowMs]);

  return { steps, runningRowIds, completionsLast60s, loading, error, version };
}
