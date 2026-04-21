"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { Row } from "@/lib/firestore/schema";
import { useAuth } from "@/components/auth-provider";
import { useAllRows } from "@/lib/firestore/useAllRows";
import { useLiveSteps } from "@/lib/firestore/useLiveSteps";
import { ScrapeGrid } from "@/components/dashboard/scrape-grid";
import { IndicatorTiles } from "@/components/dashboard/indicator-tiles";
import { LiveLog } from "@/components/dashboard/live-log";
import { PlayScrapeButton } from "@/components/dashboard/play-scrape-button";
import { SystemPauseBanner } from "@/components/dashboard/system-pause-banner";
import { RowDetailDrawer } from "@/components/row-detail-drawer";
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

export default function DashboardPage() {
  const { user, loading: authLoading, signOut } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!authLoading && !user) router.replace("/login");
  }, [user, authLoading, router]);

  const { rows, loading: rowsLoading, error: rowsError } = useAllRows();
  const { steps, runningRowIds, completionsLast60s, error: stepsError } = useLiveSteps();

  const [selectedRow, setSelectedRow] = useState<Row | null>(null);

  if (authLoading || !user) {
    return (
      <main className="flex flex-1 items-center justify-center text-muted-foreground">
        Loading…
      </main>
    );
  }

  const combinedError = rowsError ?? stepsError;

  return (
    <main className="fixed inset-0 flex flex-col gap-2 overflow-hidden p-3">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h1 className="text-base font-semibold">vc-tower · live scrape</h1>
          <Link href="/" className="text-xs text-muted-foreground underline-offset-2 hover:underline">
            ← browse rows
          </Link>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span>{user.email}</span>
          <Button variant="outline" size="sm" onClick={signOut}>
            Sign out
          </Button>
        </div>
      </header>

      {combinedError && <FirestoreError message={combinedError} />}
      <SystemPauseBanner />

      <div className="flex flex-1 gap-2 overflow-hidden">
        <section className="flex flex-1 flex-col">
          {rowsLoading && rows.length === 0 ? (
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
              loading rows…
            </div>
          ) : (
            <ScrapeGrid
              rows={rows}
              runningRowIds={runningRowIds}
              onSelect={(r) => setSelectedRow(r)}
              headerActions={<PlayScrapeButton rows={rows} />}
            />
          )}
        </section>
        <aside className="flex min-h-0 w-[20%] min-w-[320px] max-w-[440px] flex-col gap-2 overflow-hidden">
          <div className="shrink-0">
            <IndicatorTiles
              rows={rows}
              runningRowIds={runningRowIds}
              completionsLast60s={completionsLast60s}
            />
          </div>
          <div className="relative min-h-0 flex-1">
            <LiveLog steps={steps} rows={rows} onSelectRow={setSelectedRow} />
          </div>
        </aside>
      </div>

      <RowDetailDrawer
        row={selectedRow}
        open={selectedRow !== null}
        onOpenChange={(o) => {
          if (!o) setSelectedRow(null);
        }}
        devMode={process.env.NODE_ENV !== "production"}
      />
    </main>
  );
}
