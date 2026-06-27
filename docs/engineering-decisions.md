# Engineering Decisions

## 2026-06-27: Gemini Access

The app keeps Gemini calls server-side through `/api/generate` so browser clients never receive API keys.

Supported runtime modes:

- Gemini Enterprise Agent Platform with `GOOGLE_AGENT_PLATFORM_KEY`.
- Gemini Enterprise Agent Platform with `GOOGLE_GENAI_USE_ENTERPRISE=true` and documented `GOOGLE_API_KEY`.
- Gemini Enterprise Agent Platform with Application Default Credentials plus `GOOGLE_CLOUD_PROJECT`.
- Gemini Developer API fallback with `GEMINI_API_KEY` or `GOOGLE_API_KEY` when enterprise mode is not enabled.

`/healthz` reports non-secret diagnostics for provider mode, credential source, project presence, and model location.

## 2026-06-27: Frontend And Backend Frameworks

Starflow moved from inline HTML in `src/index.ts` to Vite + React + Tailwind CSS v4. TanStack Query owns API calls and optimistic UI updates.

The backend moved from a hand-written `Bun.serve` router to Hono while keeping Bun as the runtime and Cloud Run entrypoint. This is the smallest backend framework migration that makes auth, cookies, ownership checks, and JSON endpoints easier to maintain.

TanStack Start is deferred. It is a larger full-stack framework migration and currently overlaps with the Bun/Hono server and Cloud Run deploy path.

## 2026-06-27: Local Development

Local development should work without Cloud Run. `bun run dev:local` starts local Postgres, applies migrations, and runs the Bun server with file watching.

In Conductor worktrees, `CONDUCTOR_PORT` is treated as a reserved block of 10 ports. The app uses a browser-safe port from that block and Postgres uses another port from the same block. This avoids parallel workspace collisions and avoids Chrome blocked ports for the web app.

`scripts/local-env.sh` loads `.env` before generating defaults so local overrides for `PORT`, `DATABASE_URL`, and Postgres settings are respected by both the app and Compose.

## 2026-06-27: Agent Context Storage

The current persistence direction is Postgres with `pgvector`.

Local dev uses `pgvector/pgvector:0.8.3-pg16`, matching the Cloud SQL Postgres 16 direction. The schema covers users, Google OAuth accounts, agent sessions/messages, memories, and `vector(768)` memory embeddings.

Cloud SQL Postgres remains the Google-native production target. Neon or Supabase remain faster fallback options if Cloud SQL setup becomes a hackathon blocker.

## 2026-06-27: ADK Story Versus Current Runtime

The pitch should describe Starflow as an ADK-style orchestrator with specialist agents: Sense, Classifier, Triage, Coach, Breakdown, and Adjustment.

The current code implements that contract in Bun/Hono endpoints rather than importing ADK directly. This keeps the hackathon demo shippable while making the boundary explicit: `POST /api/events` is the orchestrator seam that can later become an ADK root agent. If time allows, wrap the same schema in ADK and point the frontend at that endpoint without changing the UI model.

Firestore is the cleaner Google-native shared task store for the ADK story. We are keeping Postgres for now because local dev, migrations, and Cloud SQL are already wired.
