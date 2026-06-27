import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { GoogleGenAI, Type } from "@google/genai";
import { and, count, desc, eq } from "drizzle-orm";
import { OAuth2Client } from "google-auth-library";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { db } from "./db/client";
import { appUsers, brainDumps, reflections, taskSteps, tasks } from "./db/schema";

const DEFAULT_MODEL = "gemini-2.5-flash";
const MAX_PROMPT_LENGTH = 8_000;
const SESSION_COOKIE = "starflow_session";
const DEMO_EMAIL_DOMAIN = "starflow.local";

type ProviderMode = "gemini-enterprise-agent-platform" | "gemini-developer-api";
type AgentRole = "landing" | "signin" | "capture" | "focus" | "reflect";
type UserEventType = "input_received" | "task_edited" | "task_completed";

type GeminiConfig = {
  provider: ProviderMode;
  credentialSource: string;
  apiKey: string | undefined;
  project: string | undefined;
  projectNumber: string | undefined;
  location: string;
};

type PublicUser = {
  id: string;
  email: string;
  displayName: string | null;
  isDemo: boolean;
};

type CurrentUser = PublicUser & {
  googleSubject: string | null;
};

type TriageResult = {
  main_quest?: {
    title?: string;
    why_it_matters?: string;
  };
  tiny_steps?: string[];
  detected_deadlines?: Array<{ text?: string; when?: string | null }>;
  other_tasks?: string[];
  emotional_tone?: string;
  encouragement?: string;
};

function envValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function envFlag(name: string): boolean {
  return ["1", "true", "yes", "on"].includes((envValue(name) ?? "").toLowerCase());
}

function modelName(): string {
  return envValue("GEMINI_MODEL") ?? DEFAULT_MODEL;
}

function developerApiKey(): string | undefined {
  return envValue("GEMINI_API_KEY") ?? envValue("GOOGLE_API_KEY");
}

function enterpriseApiKey(): string | undefined {
  if (envFlag("GOOGLE_GENAI_USE_ENTERPRISE")) {
    return envValue("GOOGLE_AGENT_PLATFORM_KEY") ?? envValue("GOOGLE_API_KEY");
  }

  return envValue("GOOGLE_AGENT_PLATFORM_KEY");
}

function shouldUseEnterprise(): boolean {
  if (envFlag("GOOGLE_GENAI_USE_ENTERPRISE")) {
    return true;
  }

  if (enterpriseApiKey()) {
    return true;
  }

  return Boolean(envValue("GOOGLE_CLOUD_PROJECT") && !developerApiKey());
}

function geminiConfig(): GeminiConfig {
  const project = envValue("GOOGLE_CLOUD_PROJECT");
  const projectNumber = envValue("GEMINI_PROJECT_NUMBER");
  const location = envValue("GOOGLE_CLOUD_LOCATION") ?? "global";

  if (shouldUseEnterprise()) {
    const apiKey = enterpriseApiKey();

    if (apiKey) {
      return {
        provider: "gemini-enterprise-agent-platform",
        credentialSource: envValue("GOOGLE_AGENT_PLATFORM_KEY")
          ? "GOOGLE_AGENT_PLATFORM_KEY"
          : "GOOGLE_API_KEY",
        apiKey,
        project,
        projectNumber,
        location,
      };
    }

    return {
      provider: "gemini-enterprise-agent-platform",
      credentialSource: "application-default-credentials",
      apiKey: undefined,
      project,
      projectNumber,
      location,
    };
  }

  const apiKey = developerApiKey();

  return {
    provider: "gemini-developer-api",
    credentialSource: apiKey
      ? envValue("GEMINI_API_KEY")
        ? "GEMINI_API_KEY"
        : "GOOGLE_API_KEY"
      : "not-configured",
    apiKey,
    project,
    projectNumber,
    location,
  };
}

function parsePort(rawPort: string | undefined): number {
  if (!rawPort || rawPort.trim().length === 0) {
    return 3000;
  }

  const portCandidate = rawPort.trim();

  if (!/^\d+$/.test(portCandidate)) {
    return 3000;
  }

  const parsedPort = Number(portCandidate);
  return Number.isSafeInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65_535
    ? parsedPort
    : 3000;
}

function logServerError(message: string, error: unknown): void {
  // biome-ignore lint/suspicious/noConsole: Server-side diagnostics belong in Cloud Run logs.
  console.error(message, error);
}

function configHasUsableCredentials(config: GeminiConfig): boolean {
  if (config.provider === "gemini-enterprise-agent-platform") {
    return Boolean(config.apiKey ?? config.project);
  }

  return Boolean(config.apiKey);
}

function hasUsableCredentials(): boolean {
  return configHasUsableCredentials(geminiConfig());
}

function createClient(): GoogleGenAI {
  const config = geminiConfig();

  if (config.provider === "gemini-enterprise-agent-platform") {
    if (config.apiKey) {
      return new GoogleGenAI({
        enterprise: true,
        apiKey: config.apiKey,
        apiVersion: "v1",
      });
    }

    if (!config.project) {
      throw new Error(
        "Set GOOGLE_AGENT_PLATFORM_KEY, or set GOOGLE_CLOUD_PROJECT for Application Default Credentials.",
      );
    }

    return new GoogleGenAI({
      enterprise: true,
      project: config.project,
      location: config.location,
      apiVersion: "v1",
    });
  }

  if (!config.apiKey) {
    throw new Error("Set GEMINI_API_KEY or GOOGLE_API_KEY for Gemini Developer API use.");
  }

  return new GoogleGenAI({ apiKey: config.apiKey });
}

function sessionSecret(): string {
  const secret = envValue("SESSION_SECRET");

  if (!secret && isProduction()) {
    throw new Error("SESSION_SECRET is required in production.");
  }

  return secret ?? "local-dev-insecure-starflow-session-secret";
}

function signValue(value: string): string {
  return createHmac("sha256", sessionSecret()).update(value).digest("base64url");
}

function signedSessionValue(userId: string): string {
  return `${userId}.${signValue(userId)}`;
}

function verifySessionValue(raw: string | undefined): string | null {
  if (!raw) {
    return null;
  }

  const [userId, signature] = raw.split(".");

  if (!userId || !signature) {
    return null;
  }

  const expected = signValue(userId);
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(signature);

  if (expectedBuffer.length !== actualBuffer.length) {
    return null;
  }

  return timingSafeEqual(expectedBuffer, actualBuffer) ? userId : null;
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

function isDemoEmail(email: string): boolean {
  return email.endsWith(`@${DEMO_EMAIL_DOMAIN}`);
}

function boundedJson(value: unknown, label: string): string | Response {
  const text = JSON.stringify(value ?? {});

  if (text.length > MAX_PROMPT_LENGTH) {
    return Response.json(
      { error: `${label} must serialize to ${MAX_PROMPT_LENGTH} characters or fewer.` },
      { status: 400 },
    );
  }

  return text;
}

function publicUser(user: CurrentUser): PublicUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    isDemo: isDemoEmail(user.email),
  };
}

async function currentUserFromId(userId: string): Promise<CurrentUser | null> {
  const [user] = await db
    .select({
      id: appUsers.id,
      email: appUsers.email,
      displayName: appUsers.displayName,
      googleSubject: appUsers.googleSubject,
    })
    .from(appUsers)
    .where(eq(appUsers.id, userId))
    .limit(1);

  if (!user) {
    return null;
  }

  return { ...user, isDemo: isDemoEmail(user.email) };
}

async function createDemoUser(): Promise<CurrentUser> {
  const [user] = await db
    .insert(appUsers)
    .values({
      email: `demo+${randomUUID()}@${DEMO_EMAIL_DOMAIN}`,
      displayName: "Demo",
    })
    .returning({
      id: appUsers.id,
      email: appUsers.email,
      displayName: appUsers.displayName,
      googleSubject: appUsers.googleSubject,
    });

  if (!user) {
    throw new Error("Demo user was not created.");
  }

  return { ...user, isDemo: true };
}

function allowedEmails(): Set<string> | null {
  const raw = envValue("ALLOWED_EMAILS");

  if (!raw) {
    return null;
  }

  return new Set(
    raw
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

async function requireUser(c: Context) {
  const userId = verifySessionValue(getCookie(c, SESSION_COOKIE));

  if (!userId) {
    return null;
  }

  return currentUserFromId(userId);
}

function setSessionCookie(c: Context, userId: string): void {
  setCookie(c, SESSION_COOKIE, signedSessionValue(userId), {
    httpOnly: true,
    maxAge: 60 * 60 * 24 * 30,
    path: "/",
    sameSite: "Lax",
    secure: isProduction(),
  });
}

function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, {
    path: "/",
    secure: isProduction(),
  });
}

const staticRoot = new URL("../dist/client/", import.meta.url);

const contentTypes = new Map<string, string>([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
]);

function contentTypeFor(pathname: string): string {
  const extension = pathname.match(/\.[^.]*$/)?.[0] ?? ".html";
  return contentTypes.get(extension) ?? "application/octet-stream";
}

async function serveFrontend(pathname: string): Promise<Response> {
  const safePathname = decodeURIComponent(pathname);

  if (safePathname.includes("..")) {
    return Response.json({ error: "Invalid path." }, { status: 400 });
  }

  const assetPath = safePathname === "/" ? "/index.html" : safePathname;
  const assetFile = Bun.file(new URL(`.${assetPath}`, staticRoot));

  if (await assetFile.exists()) {
    return new Response(assetFile, {
      headers: {
        "Cache-Control":
          assetPath === "/index.html" ? "no-store" : "public, max-age=31536000, immutable",
        "Content-Type": contentTypeFor(assetPath),
      },
    });
  }

  const indexFile = Bun.file(new URL("./index.html", staticRoot));

  if (await indexFile.exists()) {
    return new Response(indexFile, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/html; charset=utf-8",
      },
    });
  }

  return new Response(
    "Starflow frontend is not built yet. Run `bun run dev:local` for Vite dev mode, or `bun run build` before `bun run start`.",
    {
      status: 503,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
      },
    },
  );
}

function triageSchema() {
  return {
    type: Type.OBJECT,
    properties: {
      main_quest: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          why_it_matters: { type: Type.STRING },
        },
        required: ["title"],
      },
      tiny_steps: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
      },
      detected_deadlines: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            text: { type: Type.STRING },
            when: { type: Type.STRING, nullable: true },
          },
        },
      },
      other_tasks: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
      },
      emotional_tone: { type: Type.STRING },
      encouragement: { type: Type.STRING },
    },
    required: ["main_quest", "tiny_steps", "emotional_tone", "encouragement"],
  };
}

function chatSchema() {
  return {
    type: Type.OBJECT,
    properties: {
      reply: { type: Type.STRING },
      capture_text: { type: Type.STRING, nullable: true },
      updated_first_step: { type: Type.STRING, nullable: true },
      updated_task_title: { type: Type.STRING, nullable: true },
      updated_steps: {
        type: Type.ARRAY,
        nullable: true,
        items: { type: Type.STRING },
      },
      route: { type: Type.STRING, nullable: true },
    },
    required: ["reply"],
  };
}

function reflectionSchema() {
  return {
    type: Type.OBJECT,
    properties: {
      summary: { type: Type.STRING },
      pattern: { type: Type.STRING },
      small_win: { type: Type.STRING },
      tomorrow_experiment: { type: Type.STRING },
    },
    required: ["summary", "pattern", "small_win", "tomorrow_experiment"],
  };
}

function eventRouterSchema() {
  return {
    type: Type.OBJECT,
    properties: {
      sensed_spark: { type: Type.STRING },
      spark_type: { type: Type.STRING },
      triage_question: { type: Type.STRING },
      coach_persona: { type: Type.STRING },
      one_first_step: { type: Type.STRING },
      tiny_steps: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
      },
      priority_reason: { type: Type.STRING },
      suggested_tool_action: { type: Type.STRING },
      dashboard_note: { type: Type.STRING },
    },
    required: [
      "sensed_spark",
      "spark_type",
      "triage_question",
      "coach_persona",
      "one_first_step",
      "tiny_steps",
      "priority_reason",
      "suggested_tool_action",
      "dashboard_note",
    ],
  };
}

function parseModelJson<T>(text: string | undefined): T {
  if (!text) {
    throw new Error("Model returned no JSON text.");
  }

  const trimmed = text.trim();

  try {
    return JSON.parse(trimmed) as T;
  } catch (error) {
    const repaired = trimmed.replace(/\\u(?![0-9a-fA-F]{4})/g, "\\\\u");

    if (repaired !== trimmed) {
      return JSON.parse(repaired) as T;
    }

    throw error;
  }
}

function normalizeSteps(rawSteps: unknown): string[] {
  if (!Array.isArray(rawSteps)) {
    return ["Open the thing", "Do the smallest visible part"];
  }

  const steps = rawSteps
    .filter((step): step is string => typeof step === "string")
    .map((step) => step.trim())
    .filter(Boolean)
    .slice(0, 4);

  return steps.length > 0 ? steps : ["Open the thing", "Do the smallest visible part"];
}

function fallbackStepsForTitle(title: string): string[] {
  return [
    `Gather what you need for ${title}.`,
    `Do the smallest visible part of ${title} for five minutes.`,
  ];
}

function userAskedForStepRewrite(message: string): boolean {
  return /\b(todo|to-do|list|steps?|recipe|plan|breakdown)\b/i.test(message);
}

async function generateFreeform(prompt: string, systemInstruction: string): Promise<string> {
  const client = createClient();
  const response = await client.models.generateContent({
    model: modelName(),
    contents: prompt,
    config: {
      systemInstruction,
      temperature: 0.4,
      maxOutputTokens: 1_000,
    },
  });

  return response.text ?? "No text was returned by the model.";
}

async function generateTriage(text: string): Promise<TriageResult> {
  const client = createClient();
  const response = await client.models.generateContent({
    model: modelName(),
    contents: text,
    config: {
      systemInstruction: [
        "You help an ADHD person who just brain-dumped.",
        "From their mess, pick the SINGLE most relieving thing to focus on right now, not necessarily the most important.",
        "Break it into tiny steps where the first is doable in two minutes.",
        "Be warm and brief. Never lecture. Never produce a long list. Never tell them to just do something.",
      ].join(" "),
      responseMimeType: "application/json",
      responseSchema: triageSchema(),
      temperature: 0.5,
      maxOutputTokens: 900,
    },
  });

  return parseModelJson<TriageResult>(response.text);
}

function taskPayload(
  task: typeof tasks.$inferSelect,
  steps: Array<typeof taskSteps.$inferSelect>,
): {
  id: string;
  title: string;
  whyItMatters: string | null;
  encouragement: string | null;
  emotionalTone: string | null;
  otherTasks: string[];
  steps: Array<{ id: string; content: string; done: boolean; position: number }>;
} {
  return {
    id: task.id,
    title: task.title,
    whyItMatters: task.whyItMatters,
    encouragement: task.encouragement,
    emotionalTone: task.emotionalTone,
    otherTasks: Array.isArray(task.otherTasks) ? (task.otherTasks as string[]) : [],
    steps: steps.map((step) => ({
      id: step.id,
      content: step.content,
      done: step.done,
      position: step.position,
    })),
  };
}

async function loadOpenTask(userId: string) {
  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.userId, userId), eq(tasks.status, "open")))
    .orderBy(desc(tasks.createdAt))
    .limit(1);

  if (!task) {
    return null;
  }

  const steps = await db
    .select()
    .from(taskSteps)
    .where(eq(taskSteps.taskId, task.id))
    .orderBy(taskSteps.position);

  return taskPayload(task, steps);
}

async function loadReflectionState(userId: string) {
  const [total] = await db
    .select({ value: count() })
    .from(reflections)
    .where(eq(reflections.userId, userId));
  const [latest] = await db
    .select()
    .from(reflections)
    .where(eq(reflections.userId, userId))
    .orderBy(desc(reflections.createdAt))
    .limit(1);

  return {
    count: total?.value ?? 0,
    latest: latest
      ? {
          id: latest.id,
          summary: latest.summary,
          carryForward: latest.carryForward,
          createdAt: latest.createdAt.toISOString(),
        }
      : null,
  };
}

async function loadOwnedTask(userId: string, taskId: string) {
  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.userId, userId), eq(tasks.id, taskId)))
    .limit(1);

  if (!task) {
    return null;
  }

  const steps = await db
    .select()
    .from(taskSteps)
    .where(eq(taskSteps.taskId, task.id))
    .orderBy(taskSteps.position);

  return { task, steps, payload: taskPayload(task, steps) };
}

async function updateTaskDetails({
  taskId,
  title,
  userId,
  steps,
}: {
  taskId: string;
  title?: string;
  userId: string;
  steps?: string[];
}) {
  await db.transaction(async (tx) => {
    if (title) {
      await tx
        .update(tasks)
        .set({ title })
        .where(and(eq(tasks.id, taskId), eq(tasks.userId, userId)));
    }

    if (steps && steps.length > 0) {
      await tx.delete(taskSteps).where(eq(taskSteps.taskId, taskId));
      await tx.insert(taskSteps).values(
        steps.map((step, position) => ({
          taskId,
          content: step,
          position,
        })),
      );
    }
  });
}

function inferDirectFocusMutation(
  message: string,
): { title: string; steps: string[] | undefined } | null {
  const match = message.match(/\b(?:change|switch|replace)\b.*?\b(?:to|with)\s+([^.!?]+)/i);
  const target = match?.[1]
    ?.replace(/\b(?:and|then)\b.*$/i, "")
    .replace(/\b(?:the|a|an)\b\s+/i, "")
    .trim();

  if (!target) {
    return null;
  }

  const title = /^(make|cook|prepare|do|write|send|call|clean)\b/i.test(target)
    ? target.charAt(0).toUpperCase() + target.slice(1)
    : `Make ${target}`;

  return {
    title,
    steps: userAskedForStepRewrite(message) ? fallbackStepsForTitle(title) : undefined,
  };
}

const app = new Hono();

app.get("/healthz", (c) => {
  const config = geminiConfig();
  const geminiConfigured = configHasUsableCredentials(config);

  return c.json({
    ok: true,
    provider: config.provider,
    credentialSource: geminiConfigured ? config.credentialSource : "not-configured",
    geminiConfigured,
    cloudProjectConfigured: Boolean(config.project),
    projectNumberConfigured: Boolean(config.projectNumber),
    location: config.location,
  });
});

app.get("/api/config", (c) =>
  c.json({
    googleOAuthClientId: envValue("GOOGLE_OAUTH_CLIENT_ID") ?? null,
    geminiConfigured: hasUsableCredentials(),
    model: modelName(),
  }),
);

app.get("/api/me", async (c) => {
  const user = await requireUser(c);
  return c.json({ user: user ? publicUser(user) : null });
});

app.post("/api/auth/demo", async (c) => {
  const user = await createDemoUser();
  setSessionCookie(c, user.id);
  return c.json({ user: publicUser(user) });
});

app.post("/api/auth/google", async (c) => {
  const clientId = envValue("GOOGLE_OAUTH_CLIENT_ID");

  if (!clientId) {
    return c.json({ error: "Google sign-in is not configured." }, 503);
  }

  const body = await c.req.json<{ credential?: unknown }>();

  if (typeof body.credential !== "string" || body.credential.trim().length === 0) {
    return c.json({ error: "Google credential is required." }, 400);
  }

  const oauthClient = new OAuth2Client(clientId);
  const ticket = await oauthClient
    .verifyIdToken({
      idToken: body.credential,
      audience: clientId,
    })
    .catch(() => null);

  if (!ticket) {
    return c.json({ error: "Invalid Google credential." }, 401);
  }

  const payload = ticket.getPayload();
  const email = payload?.email?.toLowerCase();
  const subject = payload?.sub;

  if (!subject || !email || !payload.email_verified) {
    return c.json({ error: "Google account email could not be verified." }, 401);
  }

  const allowlist = allowedEmails();

  if (allowlist && !allowlist.has(email)) {
    return c.json({ error: "This Google account is not on the Starflow test-user list." }, 403);
  }

  const [user] = await db
    .insert(appUsers)
    .values({
      googleSubject: subject,
      email,
      displayName: payload.name ?? email,
    })
    .onConflictDoUpdate({
      target: appUsers.googleSubject,
      set: {
        email,
        displayName: payload.name ?? email,
      },
    })
    .returning({
      id: appUsers.id,
      email: appUsers.email,
      displayName: appUsers.displayName,
      googleSubject: appUsers.googleSubject,
    });

  if (!user) {
    throw new Error("Google user upsert did not return a row.");
  }

  setSessionCookie(c, user.id);
  return c.json({ user: publicUser({ ...user, isDemo: false }) });
});

app.post("/api/logout", (c) => {
  clearSessionCookie(c);
  return c.json({ ok: true });
});

app.post("/api/generate", async (c) => {
  const user = await requireUser(c);

  if (!user) {
    return c.json({ error: "Sign in before generating with Gemini." }, 401);
  }

  const body = await c.req.json<{ prompt?: unknown }>();

  if (typeof body.prompt !== "string" || body.prompt.trim().length === 0) {
    return c.json({ error: "Prompt is required." }, 400);
  }

  const prompt = body.prompt.trim();

  if (prompt.length > MAX_PROMPT_LENGTH) {
    return c.json({ error: `Prompt must be ${MAX_PROMPT_LENGTH} characters or fewer.` }, 400);
  }

  if (!hasUsableCredentials()) {
    return c.json(
      {
        error:
          "Gemini is not configured. Set GEMINI_API_KEY for Developer API mode, or GOOGLE_AGENT_PLATFORM_KEY / GOOGLE_CLOUD_PROJECT for Agent Platform mode.",
      },
      503,
    );
  }

  try {
    const text = await generateFreeform(
      prompt,
      [
        "You are Starflow, a gentle but practical AI support layer for ADHD minds.",
        "Help users turn scattered thoughts into one concrete next move without judgment.",
      ].join(" "),
    );
    return c.json({ text, model: modelName(), provider: geminiConfig().provider });
  } catch (error) {
    logServerError("Gemini request failed.", error);
    return c.json({ error: "Gemini request failed. Check the server logs for details." }, 502);
  }
});

app.post("/api/triage", async (c) => {
  const user = await requireUser(c);

  if (!user) {
    return c.json({ error: "Sign in before triaging a brain dump." }, 401);
  }

  const body = await c.req.json<{ text?: unknown }>();

  if (typeof body.text !== "string" || body.text.trim().length === 0) {
    return c.json({ error: "Brain dump text is required." }, 400);
  }

  const text = body.text.trim();

  if (text.length > MAX_PROMPT_LENGTH) {
    return c.json({ error: `Brain dump must be ${MAX_PROMPT_LENGTH} characters or fewer.` }, 400);
  }

  if (!hasUsableCredentials()) {
    return c.json(
      { error: "Gemini is not configured yet. Demo sign-in works, but triage needs a key." },
      503,
    );
  }

  try {
    const extracted = await generateTriage(text);
    const tinySteps = normalizeSteps(extracted.tiny_steps);
    const title = extracted.main_quest?.title?.trim() || "Choose the next small move";
    const whyItMatters = extracted.main_quest?.why_it_matters?.trim() || null;
    const otherTasks = Array.isArray(extracted.other_tasks) ? extracted.other_tasks : [];

    const payload = await db.transaction(async (tx) => {
      const [dump] = await tx
        .insert(brainDumps)
        .values({
          userId: user.id,
          rawText: text,
          extracted,
          emotionalTone: extracted.emotional_tone ?? null,
        })
        .returning({ id: brainDumps.id });

      if (!dump) {
        throw new Error("Brain dump insert did not return a row.");
      }

      const [task] = await tx
        .insert(tasks)
        .values({
          userId: user.id,
          brainDumpId: dump.id,
          title,
          whyItMatters,
          encouragement: extracted.encouragement ?? null,
          emotionalTone: extracted.emotional_tone ?? null,
          otherTasks,
        })
        .returning();

      if (!task) {
        throw new Error("Task insert did not return a row.");
      }

      const insertedSteps = await tx
        .insert(taskSteps)
        .values(
          tinySteps.map((step, position) => ({
            taskId: task.id,
            content: step,
            position,
          })),
        )
        .returning();

      return taskPayload(task, insertedSteps);
    });

    return c.json({ task: payload });
  } catch (error) {
    logServerError("Triage failed.", error);
    return c.json({ error: "Starflow could not untangle that dump. Try a shorter version." }, 502);
  }
});

app.get("/api/state", async (c) => {
  const user = await requireUser(c);

  if (!user) {
    return c.json({ error: "Sign in before loading Starflow state." }, 401);
  }

  const [task, reflection] = await Promise.all([
    loadOpenTask(user.id),
    loadReflectionState(user.id),
  ]);
  return c.json({ task, reflection });
});

app.post("/api/reflect", async (c) => {
  const user = await requireUser(c);

  if (!user) {
    return c.json({ error: "Sign in before saving a reflection." }, 401);
  }

  const body = await c.req.json<{
    answers?: unknown;
    carryForward?: unknown;
  }>();

  if (!body.answers || typeof body.answers !== "object") {
    return c.json({ error: "Reflection answers are required." }, 400);
  }

  const reflectionPrompt = boundedJson(
    {
      answers: body.answers,
      carryForward: typeof body.carryForward === "string" ? body.carryForward : "",
    },
    "Reflection payload",
  );

  if (reflectionPrompt instanceof Response) {
    return reflectionPrompt;
  }

  if (!hasUsableCredentials()) {
    return c.json({ error: "Gemini is not configured yet. Reflection needs a key." }, 503);
  }

  try {
    const client = createClient();
    const response = await client.models.generateContent({
      model: modelName(),
      contents: reflectionPrompt,
      config: {
        systemInstruction: [
          "You are Starflow's evening reflection guide for ADHD users.",
          "Summarize without judgment. Name one pattern, one small win, and one experiment for tomorrow.",
          "Keep the summary warm and brief. Do not diagnose.",
        ].join(" "),
        responseMimeType: "application/json",
        responseSchema: reflectionSchema(),
        temperature: 0.45,
        maxOutputTokens: 500,
      },
    });
    const parsed = parseModelJson<{
      summary?: string;
      pattern?: string;
      small_win?: string;
      tomorrow_experiment?: string;
    }>(response.text);
    const summary = [
      parsed.summary,
      parsed.pattern ? `Pattern: ${parsed.pattern}` : null,
      parsed.small_win ? `Small win: ${parsed.small_win}` : null,
      parsed.tomorrow_experiment ? `Tomorrow: ${parsed.tomorrow_experiment}` : null,
    ]
      .filter(Boolean)
      .join("\n");
    const [reflection] = await db
      .insert(reflections)
      .values({
        userId: user.id,
        answers: body.answers,
        carryForward: typeof body.carryForward === "string" ? body.carryForward : null,
        summary,
      })
      .returning();

    if (!reflection) {
      throw new Error("Reflection insert did not return a row.");
    }

    return c.json({
      reflection: {
        id: reflection.id,
        summary: reflection.summary,
        carryForward: reflection.carryForward,
        createdAt: reflection.createdAt.toISOString(),
      },
    });
  } catch (error) {
    logServerError("Reflection failed.", error);
    return c.json({ error: "Starflow could not gather that reflection. Try again briefly." }, 502);
  }
});

app.patch("/api/steps/:id", async (c) => {
  const user = await requireUser(c);

  if (!user) {
    return c.json({ error: "Sign in before updating a step." }, 401);
  }

  const body = await c.req.json<{ done?: unknown }>();

  if (typeof body.done !== "boolean") {
    return c.json({ error: "done must be a boolean." }, 400);
  }

  const stepId = c.req.param("id");
  const [owned] = await db
    .select({ stepId: taskSteps.id })
    .from(taskSteps)
    .innerJoin(tasks, eq(taskSteps.taskId, tasks.id))
    .where(and(eq(taskSteps.id, stepId), eq(tasks.userId, user.id)))
    .limit(1);

  if (!owned) {
    return c.json({ error: "Step not found." }, 404);
  }

  const [step] = await db
    .update(taskSteps)
    .set({ done: body.done })
    .where(eq(taskSteps.id, stepId))
    .returning();

  if (!step) {
    return c.json({ error: "Step not found." }, 404);
  }

  return c.json({
    step: {
      id: step.id,
      content: step.content,
      done: step.done,
      position: step.position,
    },
  });
});

app.post("/api/events", async (c) => {
  const user = await requireUser(c);

  if (!user) {
    return c.json({ error: "Sign in before routing an event." }, 401);
  }

  const body = await c.req.json<{
    type?: unknown;
    modality?: unknown;
    payload?: unknown;
    taskId?: unknown;
  }>();
  const eventType = typeof body.type === "string" ? (body.type as UserEventType) : null;

  if (!eventType || !["input_received", "task_edited", "task_completed"].includes(eventType)) {
    return c.json({ error: "Unknown event type." }, 400);
  }

  const modality =
    typeof body.modality === "string" && ["voice", "image", "text"].includes(body.modality)
      ? body.modality
      : "text";
  const payload = typeof body.payload === "string" ? body.payload.trim() : "";
  const payloadJson = boundedJson(body.payload ?? {}, "Event payload");

  if (payloadJson instanceof Response) {
    return payloadJson;
  }

  if (!payload && eventType === "input_received") {
    return c.json({ error: "Input events need a text payload." }, 400);
  }

  if (payload.length > MAX_PROMPT_LENGTH) {
    return c.json(
      { error: `Event payload must be ${MAX_PROMPT_LENGTH} characters or fewer.` },
      400,
    );
  }

  if (!hasUsableCredentials()) {
    return c.json({ error: "Gemini is not configured yet." }, 503);
  }

  let ownedTask: Awaited<ReturnType<typeof loadOwnedTask>> | null = null;

  if (typeof body.taskId === "string") {
    ownedTask = await loadOwnedTask(user.id, body.taskId);

    if (!ownedTask) {
      return c.json({ error: "Task not found." }, 404);
    }
  }

  if (eventType === "task_completed" && ownedTask) {
    await db
      .update(tasks)
      .set({ status: "done" })
      .where(and(eq(tasks.id, ownedTask.task.id), eq(tasks.userId, user.id)));
  }

  const prompt = [
    "You are Starflow's event router orchestrator.",
    "Run an ADK-style multi-agent flow mentally: Sense Agent, Classifier Agent, Triage Agent, Coach Agent, Breakdown Agent.",
    "Sense Agent normalizes voice/image/text into a spark. Classifier labels it creative, life-admin, emotional, recurring, urgent, or long-term.",
    "Triage Agent asks only one gentle question if needed. Coach Agent persona is Creative Coach, Life-Admin Coach, or Emotional Reset Coach.",
    "Breakdown Agent returns tiny steps and chooses exactly one first step.",
    `Event type: ${eventType}`,
    `Input modality: ${modality}`,
    ownedTask ? `Active task: ${ownedTask.payload.title}` : "Active task: none",
    ownedTask
      ? `Steps: ${ownedTask.payload.steps.map((step) => `${step.done ? "[x]" : "[ ]"} ${step.content}`).join("; ")}`
      : "Steps: none",
    `Payload: ${payload || payloadJson}`,
    "Return only the JSON requested by the schema. Keep it brief.",
  ].join("\n");

  try {
    const client = createClient();
    const response = await client.models.generateContent({
      model: modelName(),
      contents: prompt,
      config: {
        systemInstruction:
          "You orchestrate user events into task-store updates for an ADHD support app. Prefer one clear dashboard note, one first step, and tiny steps. suggested_tool_action must be one of: none, stitch, google_tasks, google_calendar.",
        responseMimeType: "application/json",
        responseSchema: eventRouterSchema(),
        temperature: 0.4,
        maxOutputTokens: 500,
      },
    });
    const routed = parseModelJson<{
      sensed_spark?: string;
      spark_type?: string;
      triage_question?: string;
      coach_persona?: string;
      one_first_step?: string;
      tiny_steps?: string[];
      priority_reason?: string | null;
      suggested_tool_action?: string;
      dashboard_note?: string;
    }>(response.text);

    return c.json({
      routed: {
        sensedSpark: routed.sensed_spark ?? payload,
        sparkType: routed.spark_type ?? "creative",
        triageQuestion: routed.triage_question ?? "What would make this feel lighter right now?",
        coachPersona: routed.coach_persona ?? "Creative Coach",
        oneFirstStep: routed.one_first_step ?? "Write one sentence about the outcome.",
        priorityReason: routed.priority_reason ?? null,
        tinySteps: normalizeSteps(routed.tiny_steps),
        suggestedToolAction: routed.suggested_tool_action ?? "none",
        dashboardNote: routed.dashboard_note ?? "Event received.",
      },
    });
  } catch (error) {
    logServerError("Event routing failed.", error);
    return c.json({ error: "Starflow could not route that event." }, 502);
  }
});

app.post("/api/chat", async (c) => {
  const user = await requireUser(c);

  if (!user) {
    return c.json({ error: "Sign in before chatting with Starflow." }, 401);
  }

  const body = await c.req.json<{
    agent?: unknown;
    message?: unknown;
    taskId?: unknown;
    uiContext?: unknown;
  }>();
  const agent = typeof body.agent === "string" ? (body.agent as AgentRole) : "focus";

  if (!["landing", "signin", "capture", "focus", "reflect"].includes(agent)) {
    return c.json({ error: "Unknown chat agent." }, 400);
  }

  if (typeof body.message !== "string" || body.message.trim().length === 0) {
    return c.json({ error: "Chat message is required." }, 400);
  }

  const message = body.message.trim();

  if (message.length > MAX_PROMPT_LENGTH) {
    return c.json({ error: `Chat message must be ${MAX_PROMPT_LENGTH} characters or fewer.` }, 400);
  }

  const uiContextJson = boundedJson(body.uiContext ?? {}, "UI context");

  if (uiContextJson instanceof Response) {
    return uiContextJson;
  }

  let ownedTask: Awaited<ReturnType<typeof loadOwnedTask>> | null = null;

  if (agent === "focus") {
    if (typeof body.taskId !== "string") {
      return c.json({ error: "Focus chat needs a taskId." }, 400);
    }

    ownedTask = await loadOwnedTask(user.id, body.taskId);

    if (!ownedTask) {
      return c.json({ error: "Task not found." }, 404);
    }
  }

  if (agent === "focus" && ownedTask) {
    const directMutation = inferDirectFocusMutation(message);

    if (directMutation) {
      const update = {
        taskId: ownedTask.task.id,
        title: directMutation.title,
        userId: user.id,
        ...(directMutation.steps ? { steps: directMutation.steps } : {}),
      };

      await updateTaskDetails(update);
      const reloaded = await loadOwnedTask(user.id, ownedTask.task.id);

      return c.json({
        reply: directMutation.steps
          ? `Updated it to ${directMutation.title} and refreshed the steps.`
          : `Updated it to ${directMutation.title}.`,
        uiPatch: { taskUpdated: true },
        task: reloaded?.payload ?? ownedTask.payload,
      });
    }
  }

  if (!hasUsableCredentials()) {
    return c.json({ error: "Gemini is not configured yet." }, 503);
  }

  const roleInstruction = {
    landing:
      "You are the Starflow landing-page concierge. Be elegant, brief, and invite the user toward the capture loop. You may suggest route='capture' when they want to try it.",
    signin:
      "You are the Starflow sign-in guide. Be calm and practical. Explain demo mode vs Google sign-in in one or two sentences. Never pretend to authenticate the user.",
    capture:
      "You are Record and Translate. Convert voice/image/text-like mess into clear user-owned words without prioritizing yet. If the user asks you to rewrite their dump, return capture_text with a gentler clearer version.",
    focus:
      "You are Receiving Adjustments and Changing Tasks, with Prioritization and Breakdown support. The user is working on the task below. If they explicitly ask to change, replace, rename, or adjust the task, return updated_task_title and/or updated_steps so the UI changes. If they say the next move is too much, shrink the first incomplete step and return updated_first_step. Keep replies to 1-3 sentences.",
    reflect:
      "You are Prioritizer for reflection. Help the user notice one meaningful signal from the day and choose what to carry tomorrow. Do not alter tasks.",
  }[agent];

  const prompt = [
    "Return JSON matching the schema.",
    `Agent: ${agent}`,
    `Instruction: ${roleInstruction}`,
    "Agent boundaries: Context normalizes available context; Task Extraction detects actionable tasks; Prioritization ranks selected active tasks; Breakdown rewrites executable subtasks. Do not invent unrelated work.",
    "Mutation rule: when the user asks for a visible task/list change, return the matching update fields instead of only chatting about it.",
    "If updated_task_title changes the task topic and the user asks to update the todo list, plan, recipe, or steps, updated_steps is required.",
    "Example: if the active task is a recipe and the user says 'change it to pasta and update the todo list', return updated_task_title like 'Make pasta' plus updated_steps for pasta.",
    `User: ${user.displayName ?? user.email}`,
    ownedTask
      ? `Task: ${ownedTask.payload.title}\nWhy: ${ownedTask.payload.whyItMatters ?? "not set"}\nSteps:\n${ownedTask.payload.steps
          .map((step) => `${step.done ? "[x]" : "[ ]"} ${step.id}: ${step.content}`)
          .join("\n")}\nTone: ${ownedTask.payload.emotionalTone ?? "unknown"}`
      : "Task: none",
    `UI context: ${uiContextJson}`,
    `User message: ${message}`,
  ].join("\n\n");

  try {
    const client = createClient();
    const response = await client.models.generateContent({
      model: modelName(),
      contents: prompt,
      config: {
        systemInstruction:
          "You are a Starflow page-specific agent. Respect the page role and only return allowed UI patches. Be brief and do not invent hidden state.",
        responseMimeType: "application/json",
        responseSchema: chatSchema(),
        temperature: 0.45,
        maxOutputTokens: 700,
      },
    });
    const parsed = parseModelJson<{
      reply?: string;
      capture_text?: string | null;
      updated_first_step?: string | null;
      updated_task_title?: string | null;
      updated_steps?: string[] | null;
      route?: string | null;
    }>(response.text);
    let updatedTask = ownedTask?.payload ?? null;
    const uiPatch: Record<string, unknown> = {};

    if (agent === "capture" && parsed.capture_text) {
      uiPatch.captureText = parsed.capture_text;
    }

    if (agent === "landing" && parsed.route === "capture") {
      uiPatch.route = "capture";
    }

    if (agent === "focus" && parsed.updated_first_step && ownedTask) {
      const target = ownedTask.steps.find((step) => !step.done);

      if (target) {
        await db
          .update(taskSteps)
          .set({ content: parsed.updated_first_step })
          .where(eq(taskSteps.id, target.id));
        const reloaded = await loadOwnedTask(user.id, ownedTask.task.id);
        updatedTask = reloaded?.payload ?? updatedTask;
        uiPatch.updatedStepId = target.id;
      }
    }

    if (agent === "focus" && ownedTask) {
      const updatedTitle = parsed.updated_task_title?.trim();
      const updatedSteps = Array.isArray(parsed.updated_steps)
        ? parsed.updated_steps
            .filter((step): step is string => typeof step === "string")
            .map((step) => step.trim())
            .filter(Boolean)
            .slice(0, 4)
        : [];
      const replacementSteps =
        updatedSteps.length > 0
          ? updatedSteps
          : updatedTitle && userAskedForStepRewrite(message)
            ? fallbackStepsForTitle(updatedTitle)
            : [];
      const shouldUpdateTitle = Boolean(updatedTitle);
      const shouldReplaceSteps = replacementSteps.length > 0;

      if (shouldUpdateTitle || shouldReplaceSteps) {
        const update = {
          taskId: ownedTask.task.id,
          userId: user.id,
          ...(updatedTitle ? { title: updatedTitle } : {}),
          ...(shouldReplaceSteps ? { steps: replacementSteps } : {}),
        };

        await updateTaskDetails(update);

        const reloaded = await loadOwnedTask(user.id, ownedTask.task.id);
        updatedTask = reloaded?.payload ?? updatedTask;
        uiPatch.taskUpdated = true;
      }
    }

    return c.json({
      reply: parsed.reply ?? "I can help shrink the next move.",
      uiPatch,
      task: updatedTask,
    });
  } catch (error) {
    logServerError("Chat failed.", error);
    return c.json({ error: "Starflow chat could not answer. Try again in a sentence." }, 502);
  }
});

app.get("*", async (c) => serveFrontend(new URL(c.req.url).pathname));

const port = parsePort(process.env.PORT);
sessionSecret();

Bun.serve({
  hostname: "0.0.0.0",
  port,
  fetch: app.fetch,
});

const startupConfig = geminiConfig();

// biome-ignore lint/suspicious/noConsole: Startup logging is useful in Cloud Run logs.
console.log(
  `Starflow API listening on http://0.0.0.0:${port} (${startupConfig.provider}, ${startupConfig.credentialSource})`,
);
