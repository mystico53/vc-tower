"use client";

// Live subscription over ALL rows in the project, no filters. Used by the
// /dashboard heatmap which paints every row as a single cell. Unlike
// useRows (filter-first, one-shot getDocs), this hook streams via onSnapshot
// and applies Firestore's docChanges incrementally to avoid reparsing 5k
// docs on every update. Cost: one-time initial read of N docs, then +1 read
// per mutated doc. See plan file for cost math.

import { useEffect, useRef, useState } from "react";
import {
  collection,
  onSnapshot,
  orderBy,
  query,
  type DocumentData,
  type QuerySnapshot,
} from "firebase/firestore";
import { getClientDb } from "@/lib/firebase/client";
import { Row, paths, DEFAULT_PROJECT_ID } from "./schema";

function parseRow(raw: DocumentData & { id: string }): Row | null {
  const parsed = Row.safeParse(raw);
  if (parsed.success) return parsed.data;
  console.warn("[useAllRows] parse failed", raw.id, parsed.error.issues);
  return null;
}

export type AllRowsResult = {
  rows: Row[];
  rowIndex: Map<string, number>;
  loading: boolean;
  error: string | null;
  version: number;
};

export function useAllRows(projectId: string = DEFAULT_PROJECT_ID): AllRowsResult {
  const mapRef = useRef<Map<string, Row>>(new Map());
  const orderRef = useRef<string[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [rowIndex, setRowIndex] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    mapRef.current = new Map();
    orderRef.current = [];
    setLoading(true);
    setError(null);

    const db = getClientDb();
    const q = query(
      collection(db, paths.rows(projectId)),
      orderBy("__name__", "asc"),
    );

    const unsub = onSnapshot(
      q,
      (snap: QuerySnapshot) => {
        const changes = snap.docChanges();
        for (const change of changes) {
          const id = change.doc.id;
          if (change.type === "removed") {
            mapRef.current.delete(id);
          } else {
            const parsed = parseRow({ id, ...change.doc.data() });
            if (parsed) mapRef.current.set(id, parsed);
          }
        }
        // Rebuild stable order from the snapshot's orderBy. Skip any doc
        // that failed to parse — leaving gaps in `rows` would break
        // downstream for-of iteration with undefined entries.
        const ordered: Row[] = [];
        const idx = new Map<string, number>();
        const ids: string[] = [];
        for (const d of snap.docs) {
          const r = mapRef.current.get(d.id);
          if (!r) continue;
          idx.set(d.id, ordered.length);
          ordered.push(r);
          ids.push(d.id);
        }
        orderRef.current = ids;
        setRows(ordered);
        setRowIndex(idx);
        setVersion((v) => v + 1);
        setLoading(false);
      },
      (err) => {
        console.error("[useAllRows] snapshot error", err);
        setError(err.message);
        setLoading(false);
      },
    );
    return () => unsub();
  }, [projectId]);

  return { rows, rowIndex, loading, error, version };
}
