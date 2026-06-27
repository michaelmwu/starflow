# Starflow

Mobile-first ADHD support app with a server-side Gemini integration. Starflow helps users capture scattered thoughts, choose one next step, and reflect without turning the browser into a credential surface.

Product and engineering decisions are tracked in:

- `docs/product-decisions.md`
- `docs/engineering-decisions.md`
- `docs/starflow-mvp-plan.md`

## Stack

- Bun + Hono HTTP server with TypeScript.
- Vite + React frontend.
- Tailwind CSS v4 styling.
- TanStack Query for frontend server state.
- Google GenAI SDK (`@google/genai`) for Gemini.
- Static Starflow frontend served by the same process.
- Cloud Run container contract: listens on `0.0.0.0` and `PORT`.

## Local Setup

Install dependencies from the committed lockfile:

```bash
bun install --frozen-lockfile
```

Create local environment variables:

```bash
cp .env.example .env
```

For the fastest local demo, set `GEMINI_API_KEY` from Google AI Studio.

If you received Google hackathon / Agent Platform variables, put them in `.env`:

```bash
GOOGLE_AGENT_PLATFORM_KEY=your-agent-platform-key
GOOGLE_CLOUD_PROJECT=your-project-id
GEMINI_PROJECT_NUMBER=your-project-number
GEMINI_API_KEY=your-gemini-api-key
```

When `GOOGLE_AGENT_PLATFORM_KEY` is present, the app uses Gemini Enterprise Agent Platform mode. `GEMINI_API_KEY` remains useful as the local Developer API fallback if the Agent Platform key is removed.

For Google Cloud mode with Application Default Credentials or a Cloud Run service account, omit `GOOGLE_AGENT_PLATFORM_KEY`, authenticate with ADC, and set:

```bash
GOOGLE_GENAI_USE_ENTERPRISE=true
GOOGLE_CLOUD_PROJECT=your-project-id
GOOGLE_CLOUD_LOCATION=global
```

Run the API and Vite frontend separately for low-level debugging:

```bash
bun run dev:api
bun run dev
```

For normal local development, prefer the integrated script:

```bash
bun run dev:local
```

In Conductor, this uses the allocated 10-port block: Vite on the browser-safe app port, Bun/Hono API on the next port, and Postgres on another port in the block.

## Local Postgres

For agent context storage, local development uses Postgres 16 with `pgvector` in Docker:

```bash
bun run db:up
bun run db:migrate
```

Or start Postgres, apply migrations, and run the full local stack in one command:

```bash
bun run dev:local
```

`dev:local` uses the Conductor-allocated port block when available and stops the local Postgres service when you press Ctrl-C.

The local scripts derive a worktree-specific Postgres port, so parallel Conductor workspaces do not all bind to `5432`. To inspect the generated values:

```bash
./scripts/local-env.sh env
```

The schema covers users, Google OAuth accounts, agent sessions/messages, memories, `vector(768)` memory embeddings, brain dumps, focus tasks, and task steps. Drizzle schema lives in `src/db/schema.ts`; bootstrap SQL migrations live in `db/migrations/`.

## MVP API

- `POST /api/auth/demo` signs in as the local demo user.
- `POST /api/auth/google` verifies a Google Identity Services ID token when `GOOGLE_OAUTH_CLIENT_ID` is configured.
- `GET /api/me` returns the signed-in user.
- `GET /api/state` returns the latest open focus task.
- `POST /api/triage` turns a brain dump into one main quest and tiny steps.
- `PATCH /api/steps/:id` toggles a tiny step.
- `POST /api/chat` runs the role-specific page agent for landing, sign-in, capture, or focus.
- `POST /api/events` routes voice/image/text, task-edited, and task-completed events through the Sense -> Classifier -> Triage -> Coach -> Breakdown orchestrator contract.

## Google Cloud Bootstrap

For Cloud Run with Gemini Enterprise Agent Platform:

1. Create or select a Google Cloud project.
2. Enable billing.
3. Enable the Agent Platform / Vertex AI API.
4. Grant the Cloud Run service account permission to call Gemini, such as `roles/aiplatform.user`.
5. Deploy with either the Agent Platform key or service account variables below.

Agent Platform key runtime variables:

```bash
GOOGLE_AGENT_PLATFORM_KEY=your-agent-platform-key
GOOGLE_CLOUD_PROJECT=your-project-id
GEMINI_PROJECT_NUMBER=your-project-number
GEMINI_MODEL=gemini-3.5-flash
```

Service account / ADC runtime variables:

```bash
GOOGLE_GENAI_USE_ENTERPRISE=true
GOOGLE_CLOUD_PROJECT=your-project-id
GOOGLE_CLOUD_LOCATION=global
GEMINI_MODEL=gemini-3.5-flash
```

## Deploy

The examples below use `--allow-unauthenticated` for fast public hackathon demos. The app still requires Starflow session auth before model calls. For production, remove that flag and put additional rate limiting, quota controls, or an application gateway in front of model-backed APIs to avoid unexpected Gemini spend or abuse.

Cloud Run also needs database and session configuration. Prefer Secret Manager for `DATABASE_URL`, `SESSION_SECRET`, and any API keys:

```bash
gcloud run deploy starflow \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --set-secrets DATABASE_URL=DATABASE_URL:latest,SESSION_SECRET=SESSION_SECRET:latest,GOOGLE_AGENT_PLATFORM_KEY=GOOGLE_AGENT_PLATFORM_KEY:latest \
  --set-env-vars GOOGLE_CLOUD_PROJECT=your-project-id,GEMINI_PROJECT_NUMBER=your-project-number
```

Before routing demo traffic to a fresh managed database, apply migrations against the production `DATABASE_URL` from a trusted machine or CI job:

```bash
DATABASE_URL='postgresql://user:password@host:5432/database' bun run db:migrate:url
```

The local `bun run db:migrate` command starts the Docker Compose Postgres service and is intended for local development only.

Build and deploy from source with Google Cloud Buildpacks:

```bash
gcloud run deploy starflow \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars GOOGLE_AGENT_PLATFORM_KEY=your-agent-platform-key,GOOGLE_CLOUD_PROJECT=your-project-id,GEMINI_PROJECT_NUMBER=your-project-number,DATABASE_URL=postgresql://user:password@host:5432/database,SESSION_SECRET=replace-with-random-secret
```

Or build the included container:

```bash
gcloud builds submit --tag us-central1-docker.pkg.dev/PROJECT_ID/starflow/starflow
gcloud run deploy starflow \
  --image us-central1-docker.pkg.dev/PROJECT_ID/starflow/starflow \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars GOOGLE_AGENT_PLATFORM_KEY=your-agent-platform-key,GOOGLE_CLOUD_PROJECT=PROJECT_ID,GEMINI_PROJECT_NUMBER=your-project-number,DATABASE_URL=postgresql://user:password@host:5432/database,SESSION_SECRET=replace-with-random-secret
```

## Checks

```bash
bun run typecheck
bun run lint
```
