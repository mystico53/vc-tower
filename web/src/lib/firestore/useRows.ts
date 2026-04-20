"use client";

// Filter-first loader: on mount, no query fires. A query is issued only when
// `filters` has at least one active field. This replaces an earlier live
// onSnapshot over the full collection (~3k docs) to avoid hammering Firestore
// on every page open.
//
// Firestore composite indexes you'll likely need (create via the link in the
// browser console when you hit a missing-index error):
//   - investor_type ==   +  completeness_score ASC
//   - hq_country ==      +  completeness_score ASC
//   - stages array-contains    +  completeness_score ASC
//   - sectors_l1 array-contains +  completeness_score ASC
// completeness_score >= alone needs no composite index.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  collection,
  getDocs,
  limit,
  orderBy,
  query,
  where,
  type DocumentData,
  type QueryConstraint,
} from "firebase/firestore";
import { getClientDb } from "@/lib/firebase/client";
import {
  Row,
  paths,
  DEFAULT_PROJECT_ID,
  type InvestorType,
  type CanonicalStage,
} from "./schema";

export type RowFilters = {
  investorType?: InvestorType;
  country?: string;
  stage?: CanonicalStage;
  sector?: string;
  minScore?: number;
  maxScore?: number;
  search?: string;
  max?: number;
};

function parseRow(raw: DocumentData & { id: string }): Row | null {
  const parsed = Row.safeParse(raw);
  if (parsed.success) return parsed.data;
  console.warn("[useRows] row parse failed", raw.id, parsed.error.issues);
  return null;
}

function isFilterActive(f: RowFilters): boolean {
  return Boolean(
    f.investorType ||
      (f.country && f.country.trim()) ||
      f.stage ||
      (f.sector && f.sector.trim()) ||
      typeof f.minScore === "number" ||
      typeof f.maxScore === "number" ||
      (f.search && f.search.trim()),
  );
}

export function useRows(
  filters: RowFilters,
  projectId: string = DEFAULT_PROJECT_ID,
) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  // Stable key so we only re-fetch when filter values actually change.
  const filterKey = useMemo(
    () =>
      JSON.stringify([
        filters.investorType ?? null,
        filters.country?.trim() || null,
        filters.stage ?? null,
        filters.sector?.trim() || null,
        typeof filters.minScore === "number" ? filters.minScore : null,
        typeof filters.maxScore === "number" ? filters.maxScore : null,
        filters.search?.trim() || null,
        filters.max ?? 200,
      ]),
    [
      filters.investorType,
      filters.country,
      filters.stage,
      filters.sector,
      filters.minScore,
      filters.maxScore,
      filters.search,
      filters.max,
    ],
  );

  const active = isFilterActive(filters);

  useEffect(() => {
    if (!active) {
      setRows([]);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    const db = getClientDb();
    const constraints: QueryConstraint[] = [];

    if (filters.investorType) {
      constraints.push(where("investor_type", "==", filters.investorType));
    }
    if (filters.country && filters.country.trim()) {
      constraints.push(where("hq_country", "==", filters.country.trim()));
    }

    // Firestore allows at most one array-contains* per query.
    // Prefer stage if both are set; apply sector client-side below.
    const hasStage = !!filters.stage;
    const sector = filters.sector?.trim();
    const clientSectorFilter = hasStage && sector ? sector : null;
    if (hasStage) {
      constraints.push(where("stages", "array-contains", filters.stage));
    } else if (sector) {
      constraints.push(where("sectors_l1", "array-contains", sector));
    }

    if (typeof filters.minScore === "number") {
      constraints.push(where("completeness_score", ">=", filters.minScore));
    }
    if (typeof filters.maxScore === "number") {
      constraints.push(where("completeness_score", "<", filters.maxScore));
    }

    // When search is the only active filter, scan the whole collection
    // (~3k docs) so matches outside the top-by-score slice are still found.
    const otherFiltersActive =
      !!filters.investorType ||
      !!filters.country?.trim() ||
      !!filters.stage ||
      !!filters.sector?.trim() ||
      typeof filters.minScore === "number" ||
      typeof filters.maxScore === "number";
    const searchOnly = !!filters.search?.trim() && !otherFiltersActive;

    constraints.push(orderBy("completeness_score", "asc"));
    constraints.push(limit(searchOnly ? 5000 : (filters.max ?? 200)));

    const q = query(collection(db, paths.rows(projectId)), ...constraints);

    const searchQ = filters.search?.trim().toLowerCase() ?? "";

    getDocs(q)
      .then((snap) => {
        if (cancelled) return;
        const parsed: Row[] = [];
        snap.forEach((doc) => {
          const r = parseRow({ id: doc.id, ...doc.data() });
          if (r) parsed.push(r);
        });
        const sectorFiltered = clientSectorFilter
          ? parsed.filter((r) => r.sectors_l1.includes(clientSectorFilter))
          : parsed;
        const final = searchQ
          ? sectorFiltered.filter((r) =>
              [r.name, r.firm_name, r.hq_country, r.investor_type, r.website, r.linkedin]
                .some((s) => s && String(s).toLowerCase().includes(searchQ)),
            )
          : sectorFiltered;
        setRows(final);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.error("[useRows] getDocs error", err);
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // filterKey captures filter identity; tick triggers manual refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, projectId, tick, active]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  return { rows, loading, error, hasQuery: active, refresh };
}
