"use client";

// Live subscription to a single row doc. Used by the detail drawer so merged
// fields (partners, portfolio, thesis, ...) appear as soon as a step finishes
// without forcing the user to re-open the drawer or refresh the table query.

import { useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { getClientDb } from "@/lib/firebase/client";
import { DEFAULT_PROJECT_ID, Row, paths } from "./schema";

export function useRow(rowId: string | null, projectId: string = DEFAULT_PROJECT_ID) {
  const [row, setRow] = useState<Row | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!rowId) {
      setRow(null);
      setError(null);
      return;
    }

    const ref = doc(getClientDb(), paths.row(projectId, rowId));
    const unsub = onSnapshot(
      ref,
      (snap) => {
        if (!snap.exists()) {
          setRow(null);
          return;
        }
        const parsed = Row.safeParse({ id: snap.id, ...snap.data() });
        if (parsed.success) {
          setRow(parsed.data);
          setError(null);
        } else {
          console.warn("[useRow] parse failed", snap.id, parsed.error.issues);
          setError("row parse failed");
        }
      },
      (err) => {
        console.error("[useRow] snapshot error", err);
        setError(err.message);
      },
    );
    return () => unsub();
  }, [rowId, projectId]);

  return { row, error };
}
