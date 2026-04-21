import type { Firestore } from "firebase-admin/firestore";
import { paths, type SystemState } from "./schema";

// Read-side helper called at the top of every runOneStep. Intentionally cheap:
// a single doc get. If the doc doesn't exist we treat it as unpaused (fresh
// project). Errors bubble up — if Firestore is down, the whole run is broken
// anyway, no point swallowing it here.
export async function getSystemState(
  db: Firestore,
  projectId: string,
): Promise<SystemState> {
  const snap = await db.doc(paths.systemState(projectId)).get();
  if (!snap.exists) {
    return { paused: false, paused_at: null, paused_reason: null, paused_tool: null, paused_kind: null };
  }
  const data = snap.data() as Partial<SystemState>;
  return {
    paused: data.paused === true,
    paused_at: typeof data.paused_at === "string" ? data.paused_at : null,
    paused_reason: typeof data.paused_reason === "string" ? data.paused_reason : null,
    paused_tool: typeof data.paused_tool === "string" ? data.paused_tool : null,
    paused_kind: typeof data.paused_kind === "string" ? data.paused_kind : null,
  };
}

// Trip the global pause. Called from runOneStep when a tool returns a "credit"
// or "auth" error_kind, or when decide() throws DecideUpstreamError. Idempotent:
// if the doc already shows paused=true we keep the ORIGINAL pause reason so the
// operator sees the first error that tripped it, not the last one racing in
// from another row. Uses a transaction to avoid a lost-update if two rows fail
// in the same instant.
export async function pauseSystem(
  db: Firestore,
  projectId: string,
  info: { reason: string; tool: string; kind: string },
): Promise<{ tripped: boolean }> {
  const ref = db.doc(paths.systemState(projectId));
  return await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const existing = snap.exists ? (snap.data() as Partial<SystemState>) : null;
    if (existing?.paused === true) {
      return { tripped: false };
    }
    const state: SystemState = {
      paused: true,
      paused_at: new Date().toISOString(),
      paused_reason: info.reason,
      paused_tool: info.tool,
      paused_kind: info.kind,
    };
    tx.set(ref, state, { merge: true });
    return { tripped: true };
  });
}

// Clear the flag. Called from /api/system/unpause. Also zeroes the metadata
// so a future pause doesn't leave a stale reason visible in the banner.
export async function unpauseSystem(
  db: Firestore,
  projectId: string,
): Promise<void> {
  const state: SystemState = {
    paused: false,
    paused_at: null,
    paused_reason: null,
    paused_tool: null,
    paused_kind: null,
  };
  await db.doc(paths.systemState(projectId)).set(state, { merge: true });
}
