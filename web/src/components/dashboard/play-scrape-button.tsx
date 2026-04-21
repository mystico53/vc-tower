"use client";

import { useRef, useState } from "react";
import { PlayIcon } from "lucide-react";
import { toast } from "sonner";
import type { Row } from "@/lib/firestore/schema";
import { useAuth } from "@/components/auth-provider";
import { Button } from "@/components/ui/button";
import { DISPLAY_STEP_MAX_PER_ROW } from "@/lib/limits";

type StepResponse =
  | { stepId: string; status: "done" | "skipped"; merged?: string[]; stop_reason?: string | null; skipped_reason?: string | null }
  | { stepId: string; status: "error"; error?: string }
  | { error: string; code?: string; paused_tool?: string; paused_kind?: string; paused_reason?: string };

const SCRAPE_COUNT = 3;
const MAX_STEPS_PER_ROW = 12; // loop safety; server caps are lower

function pickRandom<T>(pool: T[], n: number): T[] {
  const copy = pool.slice();
  const out: T[] = [];
  while (copy.length > 0 && out.length < n) {
    const i = Math.floor(Math.random() * copy.length);
    out.push(copy.splice(i, 1)[0]);
  }
  return out;
}

export function PlayScrapeButton({ rows }: { rows: Row[] }) {
  const { user } = useAuth();
  const [running, setRunning] = useState(false);
  const activeRef = useRef(false);

  async function stepOnce(rowId: string, token: string): Promise<StepResponse> {
    const res = await fetch("/api/step", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ rowId }),
    });
    return (await res.json()) as StepResponse;
  }

  async function scrapeRow(row: Row): Promise<void> {
    if (!user) return;
    const label = row.name ?? row.id;
    for (let i = 0; i < MAX_STEPS_PER_ROW; i++) {
      if (!activeRef.current) return;
      let body: StepResponse;
      try {
        const token = await user.getIdToken();
        body = await stepOnce(row.id, token);
      } catch (e) {
        toast.error(`${label}: ${(e as Error).message}`);
        return;
      }
      if ("error" in body && !("status" in body)) {
        // Global pause tripped by this row or a sibling — halt every parallel
        // scraper immediately so we don't keep spending against a dead
        // provider while the operator tops up credits.
        if (body.code === "system_paused") {
          activeRef.current = false;
          toast.error(
            `paused · ${body.paused_tool ?? "upstream"} ${body.paused_kind ?? "error"}`,
            { description: body.paused_reason ?? body.error },
          );
          return;
        }
        toast.error(`${label}: ${body.error}`);
        return;
      }
      if ("status" in body) {
        if (body.status === "error") {
          toast.error(`${label}: ${body.error ?? "error"}`);
          return;
        }
        if (body.status === "skipped") {
          toast.warning(`${label}: budget reached`);
          return;
        }
        if (body.stop_reason) {
          toast.success(`${label}: done · ${body.stop_reason}`);
          return;
        }
      }
    }
    toast.message(`${label}: reached step cap`);
  }

  async function onPlay() {
    if (!user || running) return;
    const pool = rows.filter(
      (r) =>
        r.scrape_status !== "complete" &&
        (r.total_steps ?? 0) < DISPLAY_STEP_MAX_PER_ROW,
    );
    if (pool.length === 0) {
      toast.warning("No rows available to scrape.");
      return;
    }
    const picks = pickRandom(pool, SCRAPE_COUNT);
    setRunning(true);
    activeRef.current = true;
    toast.message(`Scraping ${picks.length}: ${picks.map((r) => r.name ?? r.id).join(", ")}`);
    try {
      await Promise.all(picks.map((r) => scrapeRow(r)));
    } finally {
      activeRef.current = false;
      setRunning(false);
    }
  }

  function onStop() {
    activeRef.current = false;
  }

  return (
    <Button
      size="sm"
      variant={running ? "outline" : "default"}
      onClick={running ? onStop : onPlay}
      disabled={!user}
      title={running ? "Stop scraping after current step" : `Scrape ${SCRAPE_COUNT} random rows`}
    >
      <PlayIcon className="size-3.5" />
      {running ? "Stop" : `Play · ${SCRAPE_COUNT}`}
    </Button>
  );
}
