# Starflow MVP Plan

## Current Direction

Build one loop optimized for ADHD speed-to-relief:

1. Sign in with demo mode or identity-only Google sign-in.
2. Dump messy thoughts into one capture field.
3. Use one Gemini structured-output call to choose one main quest and tiny steps.
4. Show a focus screen with checkable steps.
5. Keep a page-specific chat agent available to shrink or adjust the current UI context.

## Framework Decision

The repo now uses:

- Vite + React for the frontend.
- Tailwind CSS v4 for styling.
- TanStack Query for server-state calls and optimistic step toggles.
- Bun + Hono for the backend and Cloud Run entrypoint.
- Drizzle + Postgres for persistence.

We intentionally did not migrate to TanStack Start yet. TanStack Start is attractive for a fuller app with SSR/routing/server functions, but it would replace too much of the existing Bun/Cloud Run shape during the hackathon. Hono gives us cleaner API routes while keeping the current runtime and deploy model.

## AI Roles And Event Router

Starflow's AI surface should be presented as an ADK-style multi-agent system:

- Context Agent: normalizes multimodal and tool context into structured context.
- Task Extraction Agent: extracts candidate tasks into an inbox.
- Prioritization Agent: prioritizes selected active tasks only.
- Breakdown Agent: creates tiny executable subtasks.
- Adjustment Agent: handles task edits, task completions, and "this feels too much" changes.

User events flow through an event-router shape:

```text
User Events
  -> Voice/Image/Text | Task Edited | Task Completed
  -> Event Router / Orchestrator
  -> Sense + Classify + Triage + Coach + Breakdown
  -> Shared Task Store
  -> Active Dashboard
```

The backend exposes `POST /api/events` as this orchestrator surface. It returns the sensed spark, spark type, triage question, coach persona, first step, tiny steps, priority reason, dashboard note, and a suggested tool action (`none`, `stitch`, `google_tasks`, or `google_calendar`).

In a production Google-native version, the shared task store should move to Firestore if we want the hackathon story to be ADK root agent -> Firestore -> active dashboard. Current local implementation uses Postgres because the repo already has Drizzle/Postgres wiring.

Each page also gets a scoped agent personality:

- Landing/sign-in: guide only, no hidden state mutation.
- Capture: Sense/Record and Translate; may patch the current dump text.
- Focus: Adjustment Agent with Prioritization and Breakdown support; may shrink/persist the first incomplete step, rename the active task, or replace its step list.
- Reflect: Prioritizer for daily reflection; helps choose what carries forward.

The mutation surface is intentionally narrow. Agents receive only the UI context for the active page and may only return allowed patches.

## Out Of Scope For MVP

- Gmail API access.
- Embeddings/RAG.
- Multi-project task management.
- Reflection loops beyond the original landing story.
- Voice upload/transcription.
