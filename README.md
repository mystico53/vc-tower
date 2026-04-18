# vc-tower

Investor enrichment orchestrator with a step-by-step debug UI.

## Layout

```
/web                 Next.js 16 app (App Router, TS, Tailwind 4, shadcn/ui)
/data                masterlist.db (produced by scripts/build_masterlist.py; gitignored)
/lists               xlsx input files
/strategy docs       criteria & matching notes
/scripts             Python masterlist builder (sibling worktree)
/functions           Firebase Cloud Functions (empty in v1; used for batch runner later)
/firebase.json       Firestore rules + App Hosting config (at repo root)
/firestore.rules     Firestore security rules (at repo root)
/vc-tower-firebase-adminsdk-*.json
                     Service account JSON — gitignored, referenced via
                     GOOGLE_APPLICATION_CREDENTIALS in web/.env.local
```

## Required tweaks to the root Firebase config

Firebase init at repo root created defaults. For the web app to deploy, apply:

**`apphosting` block in `firebase.json` — change `rootDir`:**

```diff
  "apphosting": {
    "backendId": "vc-tower",
-   "rootDir": "/",
+   "rootDir": "web",
```

**`firestore.rules` — replace the default open-until-30-days rule with auth-gated read + admin-only write:**

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /projects/{pid} {
      allow read: if request.auth != null;
      allow write: if false;
      match /rows/{rowId} {
        allow read: if request.auth != null;
        allow write: if false;
        match /steps/{stepId} {
          allow read: if request.auth != null;
          allow write: if false;
        }
      }
    }
  }
}
```

(All writes go through Admin SDK in `/api/*` route handlers.)

**`.gitignore` at repo root — add:**

```
vc-tower-firebase-adminsdk-*.json
/data/
/web/.env*
!/web/.env.example
```

## Local setup

Prereqs: Node ≥ 20, Firestore + Google Auth enabled in the `vc-tower` Firebase
project, and a run of `scripts/build_masterlist.py` producing `data/masterlist.db`.

```bash
cd web
npm install
cp .env.example .env.local
# edit .env.local: fill Firebase web config + INGEST_TOKEN + MASTERLIST_DB_PATH
# GOOGLE_APPLICATION_CREDENTIALS should already point at the root service-account JSON
npm run dev
```

Sign in at http://localhost:3000/login with Google.

## Ingesting the masterlist

The ingest route reads `data/masterlist.db` directly via `better-sqlite3` and
writes to Firestore under `/projects/default/rows/{id}`. Run it after each
Python rebuild:

```bash
curl -X POST http://localhost:3000/api/ingest \
  -H "x-ingest-token: $INGEST_TOKEN"
```

Idempotent — re-runs merge by masterlist `id`.

## Data flow

```
xlsx sources      →  scripts/build_masterlist.py  →  data/masterlist.db  (SQLite, local)
                                                              │
                                                  POST /api/ingest (one-shot)
                                                              │
                                                              ▼
                                                     Firestore /projects/default/rows
                                                              │
                                                              ▼  (PR #2)
                                               orchestrator fills missing_fields
                                                       step log under /rows/{id}/steps
```

Firestore is the source of truth post-ingest. SQLite is the "reset / rebuild"
path when the Python pipeline changes.

## Firestore model

```
/projects/{projectId}                    — project metadata
/projects/{projectId}/rows/{rowId}       — one investor row (masterlist columns + enrichment state)
/projects/{projectId}/rows/{rowId}/steps/{stepId}
                                         — audit log of orchestrator decisions + tool calls
```

## Deploy (Firebase App Hosting)

```bash
firebase deploy --only firestore:rules,firestore:indexes
# App Hosting picks up the Next app from /web on push to main (after rootDir fix above)
```

## Roadmap

- **PR #1 (this):** scaffold, auth, virtual table, ingest.
- **PR #2:** orchestrator — Qwen 3.5 Plus tool-calling decides which enrichment
  tool to run per row (Firecrawl / Apify LinkedIn / Grok X Search), writes
  step doc to Firestore, UI streams live.
- **PR #3+:** batch auto-run via Cloud Functions + Cloud Tasks, Crunchbase
  enrichment, embeddings for semantic thesis matching.
