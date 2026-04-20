# Setup on a new machine

What you need besides `git clone`, and where each piece goes.

## 1. Secrets that are NOT in the repo

Three files are gitignored and must be copied in separately. Canonical copy
lives in Google Drive under `coding gdrive/vc-tower secrets/`.

| File | Put it at | Purpose |
| --- | --- | --- |
| `.env.local` | `web/.env.local` | API keys, Firebase client config, paths to local files below. Contains DashScope, Firecrawl, Apify, xAI, Firebase Admin, plus `HARNESS_DEV_KEY`. |
| `vc-tower-firebase-adminsdk-fbsvc-*.json` | repo root (`./`) | Firebase Admin service-account key. Referenced by `GOOGLE_APPLICATION_CREDENTIALS` in `.env.local`. |
| `masterlist.db` | `data/masterlist.db` | SQLite investor list used only by `scripts/build_masterlist.py` and `/api/ingest`. Not needed for day-to-day orchestrator work — Firestore already has the ingested data. |

## 2. Adjust absolute paths in `.env.local`

The copy from another machine will have Windows paths baked in. On the new
machine, rewrite these two lines to match the local layout:

```
GOOGLE_APPLICATION_CREDENTIALS=<absolute path to the admin JSON>
MASTERLIST_DB_PATH=<absolute path to data/masterlist.db>
```

On macOS/Linux use forward slashes; on Windows escape backslashes as `\\`.

## 3. Install + run

```
cd web
npm install
npm run dev
```

App lives at http://localhost:3000. `npm run dev` sets `NODE_ENV=development`,
which is also what gates the dev-only harness endpoint.

## 4. Optional: enable the harness locally

`POST /api/step/harness` runs multi-step enrichment scripted. It's off by
default and requires two things:

1. `HARNESS_DEV_KEY=...` set in `.env.local` (already in the synced file).
2. `NODE_ENV !== "production"` (always true under `npm run dev`).

Then:

```
curl -X POST http://localhost:3000/api/step/harness \
  -H "content-type: application/json" \
  -H "x-dev-key: <HARNESS_DEV_KEY value>" \
  -d '{"rowId":"1272","steps":3,"reset":true}'
```

## 5. Firebase project wiring

The app is wired to the `vc-tower` Firebase project. If you're pointing at a
different project, update `NEXT_PUBLIC_FIREBASE_PROJECT_ID` + the other
`NEXT_PUBLIC_FIREBASE_*` client keys in `.env.local`, plus
`FIREBASE_PROJECT_ID` for the Admin SDK. The service-account JSON must belong
to that same project.

## 6. Firestore indexes + rules

Already committed as `firestore.indexes.json` and `firestore.rules`. Deploy
them once when onboarding a new Firebase project:

```
firebase deploy --only firestore:indexes,firestore:rules
```

## 7. Rotating keys

If a key leaks, rotate it at the provider first, then update `.env.local`
everywhere (local machine + the Google Drive copy). Keys to know:

- DashScope (Qwen) — alibabacloud console
- Firecrawl — firecrawl.dev dashboard
- Apify — apify.com integrations
- xAI (Grok) — console.x.ai
- Firebase admin JSON — Firebase console → Project Settings → Service accounts (generate new key)
