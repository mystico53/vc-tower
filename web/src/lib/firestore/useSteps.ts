"use client";

import { useEffect, useState } from "react";
import {
  collection,
  onSnapshot,
  orderBy,
  query,
  type DocumentData,
  type QuerySnapshot,
} from "firebase/firestore";
import { getClientDb } from "@/lib/firebase/client";
import { Step, paths, DEFAULT_PROJECT_ID } from "./schema";

function parseStep(raw: DocumentData & { id: string }): Step | null {
  const parsed = Step.safeParse(raw);
  if (parsed.success) return parsed.data;
  console.warn("[useSteps] parse failed", raw.id, parsed.error.issues);
  return null;
}

export function useSteps(
  rowId: string | null,
  projectId: string = DEFAULT_PROJECT_ID,
) {
  const [steps, setSteps] = useState<Step[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!rowId) {
      setSteps([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const db = getClientDb();
    const path = paths.steps(projectId, rowId);
    console.log("[useSteps] subscribing", path);
    const q = query(collection(db, path), orderBy("idx", "asc"));
    const unsub = onSnapshot(
      q,
      (snap: QuerySnapshot) => {
        console.log("[useSteps] snapshot size=", snap.size, "path=", path);
        const parsed: Step[] = [];
        snap.forEach((doc) => {
          const s = parseStep({ id: doc.id, ...doc.data() });
          if (s) parsed.push(s);
        });
        setSteps(parsed);
        setLoading(false);
      },
      (err) => {
        console.error("[useSteps] snapshot error", path, err);
        setError(err.message);
        setLoading(false);
      },
    );
    return () => {
      console.log("[useSteps] unsubscribing", path);
      unsub();
    };
  }, [rowId, projectId]);

  return { steps, loading, error };
}
