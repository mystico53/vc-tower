"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAuth } from "@/components/auth-provider";
import { RowTable } from "@/components/row-table";
import { useRows } from "@/lib/firestore/useRows";
import { Button } from "@/components/ui/button";

export default function Home() {
  const { user, loading: authLoading, signOut } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!authLoading && !user) router.replace("/login");
  }, [user, authLoading, router]);

  const { rows, loading, error } = useRows();

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
        <Button variant="outline" size="sm" onClick={signOut}>
          Sign out
        </Button>
      </header>

      {error && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">
          Firestore error: {error}
        </div>
      )}

      {loading ? (
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          Loading rows…
        </div>
      ) : rows.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
          <p className="text-muted-foreground">No rows yet.</p>
          <p className="max-w-md text-xs text-muted-foreground">
            Run the ingest script to import <code>data/masterlist.db</code> into
            Firestore. See <code>README.md</code>.
          </p>
        </div>
      ) : (
        <RowTable rows={rows} />
      )}
    </main>
  );
}
