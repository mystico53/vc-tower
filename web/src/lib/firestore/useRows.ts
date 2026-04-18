"use client";

import { useEffect, useState } from "react";
import {
  collection,
  onSnapshot,
  orderBy,
  query,
  type QuerySnapshot,
  type DocumentData,
} from "firebase/firestore";
import { getClientDb } from "@/lib/firebase/client";
import { Row, paths, DEFAULT_PROJECT_ID } from "./schema";

function parseRow(raw: DocumentData & { id: string }): Row | null {
  const parsed = Row.safeParse(raw);
  if (parsed.success) return parsed.data;
  // Soft-fail: log and skip the row rather than crash the table.
  console.warn("[useRows] row parse failed", raw.id, parsed.error.issues);
  return null;
}

export function useRows(projectId: string = DEFAULT_PROJECT_ID) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const db = getClientDb();
    const q = query(
      collection(db, paths.rows(projectId)),
      orderBy("completeness_score", "asc"),
    );

    const unsub = onSnapshot(
      q,
      (snap: QuerySnapshot) => {
        const parsed: Row[] = [];
        snap.forEach((doc) => {
          const r = parseRow({ id: doc.id, ...doc.data() });
          if (r) parsed.push(r);
        });
        setRows(parsed);
        setLoading(false);
      },
      (err) => {
        console.error("[useRows] snapshot error", err);
        setError(err.message);
        setLoading(false);
      },
    );

    return unsub;
  }, [projectId]);

  return { rows, loading, error };
}
