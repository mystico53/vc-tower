"use client";

import { useState } from "react";
import { toast } from "sonner";
import { useAuth } from "@/components/auth-provider";
import { Button } from "@/components/ui/button";
import { useSystemPause } from "@/lib/firestore/useSystemPause";

// Shown above the dashboard whenever projects/default/system/state.paused is
// true. Subscribes live so the banner appears within ~1s of a credit-tripped
// run and disappears as soon as someone clicks Resume. Any authenticated user
// can un-pause — same trust level as the Play button.
export function SystemPauseBanner() {
  const { paused, paused_reason, paused_tool, paused_kind, paused_at } = useSystemPause();
  const { user } = useAuth();
  const [resuming, setResuming] = useState(false);

  if (!paused) return null;

  async function onResume() {
    if (!user || resuming) return;
    setResuming(true);
    try {
      const token = await user.getIdToken();
      const res = await fetch("/api/system/unpause", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error(`unpause failed: ${body.error ?? res.status}`);
        return;
      }
      toast.success("run resumed");
    } catch (e) {
      toast.error(`unpause failed: ${(e as Error).message}`);
    } finally {
      setResuming(false);
    }
  }

  const when = paused_at ? new Date(paused_at).toLocaleTimeString() : "—";

  return (
    <div className="flex items-start justify-between gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200">
      <div className="min-w-0 flex-1">
        <div className="font-medium">Run paused · {paused_tool ?? "unknown"} ({paused_kind ?? "error"})</div>
        <div className="mt-0.5 truncate text-xs opacity-80">
          {paused_reason ?? "no reason recorded"} · tripped at {when}
        </div>
        <div className="mt-0.5 text-[11px] opacity-70">
          New /api/step calls will 409 until resumed. Top up credits, then click Resume.
        </div>
      </div>
      <Button
        size="sm"
        variant="outline"
        onClick={onResume}
        disabled={!user || resuming}
      >
        {resuming ? "Resuming…" : "Resume"}
      </Button>
    </div>
  );
}
