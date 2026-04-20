"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { RowTable } from "@/components/row-table";
import { useRows, type RowFilters } from "@/lib/firestore/useRows";
import { Button } from "@/components/ui/button";

function FirestoreError({ message }: { message: string }) {
  const urlMatch = message.match(/https?:\/\/[^\s)]+/);
  const url = urlMatch?.[0];
  const isMissingIndex = /requires an index/i.test(message);
  const rest = url ? message.replace(url, "").trim() : message;

  return (
    <div className="flex flex-col gap-2 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">
      <div className="font-medium">
        {isMissingIndex ? "Missing Firestore index" : "Firestore error"}
      </div>
      <div className="text-xs opacity-90">{rest}</div>
      {url && (
        <a
          href={url}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex w-fit items-center gap-1 rounded-md border border-red-500/40 bg-background px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-500/10 dark:text-red-300"
        >
          {isMissingIndex ? "Create index in Firebase console" : "Open link"} ↗
        </a>
      )}
    </div>
  );
}

export default function Home() {
  const { user, loading: authLoading, signOut } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!authLoading && !user) router.replace("/login");
  }, [user, authLoading, router]);

  const [filters, setFilters] = useState<RowFilters>({ max: 200 });
  const { rows, loading, error, hasQuery, refresh } = useRows(filters);

  if (authLoading || !user) {
    return (
      <main className="flex flex-1 items-center justify-center text-muted-foreground">
        Loading…
      </main>
    );
  }

  return (
    <main className="flex flex-1 flex-col gap-4 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">vc-tower</h1>
          <p className="text-xs text-muted-foreground">
            {user.email} · investor enrichment debug
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/dashboard"
            className="text-xs font-medium text-foreground underline-offset-2 hover:underline"
          >
            Live dashboard →
          </Link>
          <Button variant="outline" size="sm" onClick={signOut}>
            Sign out
          </Button>
        </div>
      </header>

      {error && <FirestoreError message={error} />}

      <RowTable
        rows={rows}
        filters={filters}
        onFiltersChange={setFilters}
        hasQuery={hasQuery}
        loading={loading}
        onRefresh={refresh}
      />
    </main>
  );
}
