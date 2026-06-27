import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  type Content,
  type FunctionCall,
  FunctionCallingConfigMode,
  type FunctionDeclaration,
  GoogleGenAI,
  Type,
} from "@google/genai";
import { and, count, desc, eq, gte, lt, sql } from "drizzle-orm";
import { OAuth2Client } from "google-auth-library";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { db } from "./db/client";
import { agentMemories, appUsers, brainDumps, reflections, taskSteps, tasks } from "./db/schema";

const DEFAULT_MODEL = "gemini-3.5-flash";
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

type MemoryCategoryResult = {
  categories?: Array<{
    name?: string;
    summary?: string;
    memory_ids?: string[];
  }>;
};

type CategorizedMemory = {
  id: string;
  content: string;
  createdAt: string;
};

type CategorizedMemoryGroup = {
  name: string;
  summary: string;
  memories: CategorizedMemory[];
};

const memoryCategoryCache = new Map<
  string,
  {
    categories: CategorizedMemoryGroup[];
    expiresAt: number;
    latestId: string | null;
    model: string | null;
    total: number;
    usedModel: boolean;
  }
>();

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
const staticRootPath = decodeURIComponent(staticRoot.pathname).replace(/\/?$/, "/");

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
  let safePathname: string;

  try {
    safePathname = decodeURIComponent(pathname);
  } catch {
    return Response.json({ error: "Invalid path." }, { status: 400 });
  }

  if (safePathname.includes("..") || safePathname.includes("%2e")) {
    return Response.json({ error: "Invalid path." }, { status: 400 });
  }

  const assetPath = safePathname === "/" ? "/index.html" : safePathname;
  const assetUrl = new URL(`.${assetPath}`, staticRoot);
  const assetFile = Bun.file(assetUrl);
  const assetFileName = assetFile.name ?? "";

  if (!assetFileName.startsWith(staticRootPath)) {
    return Response.json({ error: "Invalid path." }, { status: 400 });
  }

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
        description:
          "4 to 6 short, high-leverage steps. The first step should take about two minutes.",
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
      carry_forward: { type: Type.STRING, nullable: true },
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

function dailyReportSchema() {
  return {
    type: Type.OBJECT,
    properties: {
      headline: { type: Type.STRING },
      encouragement: { type: Type.STRING },
      observations: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
      },
      threads: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            label: { type: Type.STRING },
            detail: { type: Type.STRING },
          },
          required: ["label", "detail"],
        },
      },
      carry_forward: { type: Type.STRING },
    },
    required: ["headline", "encouragement", "observations", "threads", "carry_forward"],
  };
}

function photoCaptureSchema() {
  return {
    type: Type.OBJECT,
    properties: {
      memory_text: { type: Type.STRING },
      note: { type: Type.STRING },
    },
    required: ["memory_text", "note"],
  };
}

function memoryCategoriesSchema() {
  return {
    type: Type.OBJECT,
    properties: {
      categories: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            name: { type: Type.STRING },
            summary: { type: Type.STRING },
            memory_ids: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
          },
          required: ["name", "summary", "memory_ids"],
        },
      },
    },
    required: ["categories"],
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

  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  const objectCandidate = trimmed.slice(
    Math.max(0, trimmed.indexOf("{")),
    trimmed.lastIndexOf("}") + 1 || trimmed.length,
  );
  const candidates = [trimmed, objectCandidate].filter(Boolean);

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch (error) {
      const repaired = candidate
        .replace(/\\u(?![0-9a-fA-F]{4})/g, "\\\\u")
        .replace(/([{,]\s*)([A-Za-z_][\w-]*)(\s*:)/g, '$1"$2"$3')
        .replace(/,\s*([}\]])/g, "$1");

      if (repaired !== candidate) {
        try {
          return JSON.parse(repaired) as T;
        } catch {
          // Try the next candidate before surfacing the original parse error.
        }
      }

      if (candidate === candidates.at(-1)) {
        throw error;
      }
    }
  }

  throw new Error("Model returned no JSON object.");
}

function modelResponseText(response: {
  text?: string | undefined;
  candidates?:
    | Array<{
        content?:
          | {
              parts?: Array<{ text?: string | undefined }> | undefined;
            }
          | undefined;
      }>
    | undefined;
}): string | undefined {
  const directText = response.text?.trim();

  if (directText) {
    return directText;
  }

  const partsText =
    response.candidates
      ?.flatMap((candidate) => candidate.content?.parts ?? [])
      .map((part) => part.text ?? "")
      .join("")
      .trim() ?? "";

  return partsText || undefined;
}

function normalizeSteps(rawSteps: unknown): string[] {
  if (!Array.isArray(rawSteps)) {
    return [
      "Open the relevant app, page, object, or space.",
      "Name the smallest visible outcome.",
      "Gather only what is needed.",
      "Do the first two-minute action.",
    ];
  }

  const steps = rawSteps
    .filter((step): step is string => typeof step === "string")
    .map((step) => step.trim())
    .filter(Boolean)
    .slice(0, 6);

  return steps.length > 0 ? steps : normalizeSteps(null);
}

async function generateFreeform(prompt: string, systemInstruction: string): Promise<string> {
  const client = createClient();
  const response = await client.models.generateContent({
    model: modelName(),
    contents: prompt,
    config: {
      systemInstruction,
      temperature: 0.4,
      maxOutputTokens: 2_500,
    },
  });

  return modelResponseText(response) ?? "No text was returned by the model.";
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
        "Break the focus into 4 to 6 short, concrete steps in order.",
        "The first step must be doable in about two minutes. Each step is one small physical action.",
        "Do not over-explain. Prefer short step labels over detailed instructions.",
        "Be warm and brief. Never lecture. Never tell them to just do something.",
      ].join(" "),
      responseMimeType: "application/json",
      responseSchema: triageSchema(),
      temperature: 0.5,
      maxOutputTokens: 2_500,
    },
  });

  return parseModelJson<TriageResult>(modelResponseText(response));
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

async function loadReflections(userId: string, limit = 30) {
  const rows = await db
    .select()
    .from(reflections)
    .where(eq(reflections.userId, userId))
    .orderBy(desc(reflections.createdAt))
    .limit(limit);

  return rows.map((reflection) => ({
    id: reflection.id,
    summary: reflection.summary,
    carryForward: reflection.carryForward,
    createdAt: reflection.createdAt.toISOString(),
  }));
}

async function loadMemoryState(userId: string) {
  const [total] = await db
    .select({ value: count() })
    .from(agentMemories)
    .where(eq(agentMemories.userId, userId));
  const [latest] = await db
    .select()
    .from(agentMemories)
    .where(eq(agentMemories.userId, userId))
    .orderBy(desc(agentMemories.createdAt))
    .limit(1);

  return {
    count: total?.value ?? 0,
    latest: latest
      ? {
          id: latest.id,
          content: latest.content,
          createdAt: latest.createdAt.toISOString(),
        }
      : null,
  };
}

async function loadScatterMemories(
  userId: string,
  limit = 60,
  window?: { since: Date; until: Date },
) {
  const predicates = [eq(agentMemories.userId, userId), eq(agentMemories.sourceKind, "manual")];

  if (window) {
    predicates.push(gte(agentMemories.createdAt, window.since));
    predicates.push(lt(agentMemories.createdAt, window.until));
  }

  return db
    .select()
    .from(agentMemories)
    .where(and(...predicates))
    .orderBy(desc(agentMemories.createdAt))
    .limit(limit);
}

function memorySnippet(content: string): string {
  return content.length > 180 ? `${content.slice(0, 177)}...` : content;
}

function parseImageDataUrl(dataUrl: string) {
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=]+)$/);

  if (!match?.[1] || !match[2]) {
    return null;
  }

  return {
    mimeType: match[1] === "image/jpg" ? "image/jpeg" : match[1],
    data: match[2],
  };
}

function localMemoryCategory(content: string): string {
  const lower = content.toLowerCase();

  if (/(overwhelm|stuck|tired|shame|sad|mad|angry|feel|feeling|worry|worried)/.test(lower)) {
    return "Emotional sparks";
  }

  if (/(reply|email|call|tax|bill|appointment|schedule|calendar|paperwork|admin)/.test(lower)) {
    return "Life admin";
  }

  if (/(build|make|write|design|idea|app|project|create|draft)/.test(lower)) {
    return "Creative ideas";
  }

  if (/(clean|kitchen|room|laundry|dish|desk|home|trash)/.test(lower)) {
    return "Home and space";
  }

  return "Loose thoughts";
}

function fallbackMemoryCategories(memories: Awaited<ReturnType<typeof loadScatterMemories>>) {
  const grouped = new Map<string, typeof memories>();

  for (const memory of memories) {
    const name = localMemoryCategory(memory.content);
    grouped.set(name, [...(grouped.get(name) ?? []), memory]);
  }

  return [...grouped.entries()].map(([name, rows]) => ({
    name,
    summary: `${rows.length} saved thought${rows.length === 1 ? "" : "s"}.`,
    memories: rows.map((memory) => ({
      id: memory.id,
      content: memory.content,
      createdAt: memory.createdAt.toISOString(),
    })),
  }));
}

async function categorizeMemories(memories: Awaited<ReturnType<typeof loadScatterMemories>>) {
  if (memories.length === 0 || !hasUsableCredentials()) {
    return { categories: fallbackMemoryCategories(memories), usedModel: false };
  }

  const byId = new Map(memories.map((memory) => [memory.id, memory]));
  const prompt = [
    "Categorize these Scatter thoughts for an ADHD support app.",
    "Use warm, practical category names like Creative ideas, Life admin, Emotional sparks, Home and space, People, Health, Money, or Loose thoughts.",
    "Every memory id must appear in exactly one category. Do not diagnose the user.",
    memories
      .map(
        (memory) => `- ${memory.id}: ${memorySnippet(memory.content).replace(/\s+/g, " ").trim()}`,
      )
      .join("\n"),
  ].join("\n\n");

  try {
    const client = createClient();
    const response = await client.models.generateContent({
      model: modelName(),
      contents: prompt,
      config: {
        systemInstruction:
          "You organize saved user thoughts into gentle, useful buckets. Return only JSON.",
        responseMimeType: "application/json",
        responseSchema: memoryCategoriesSchema(),
        temperature: 0.25,
        maxOutputTokens: 2_500,
      },
    });
    const parsed = parseModelJson<MemoryCategoryResult>(modelResponseText(response));
    const assigned = new Set<string>();
    const categories =
      parsed.categories
        ?.map((category) => {
          const rows =
            category.memory_ids
              ?.map((id) => byId.get(id))
              .filter((memory): memory is (typeof memories)[number] => Boolean(memory)) ?? [];

          for (const row of rows) {
            assigned.add(row.id);
          }

          return {
            name: category.name?.trim() || "Loose thoughts",
            summary: category.summary?.trim() || `${rows.length} saved thoughts.`,
            memories: rows.map((memory) => ({
              id: memory.id,
              content: memory.content,
              createdAt: memory.createdAt.toISOString(),
            })),
          };
        })
        .filter((category) => category.memories.length > 0) ?? [];
    const unassigned = memories.filter((memory) => !assigned.has(memory.id));

    if (unassigned.length > 0) {
      categories.push(...fallbackMemoryCategories(unassigned));
    }

    return {
      categories: categories.length > 0 ? categories : fallbackMemoryCategories(memories),
      usedModel: categories.length > 0,
    };
  } catch (error) {
    logServerError("Memory categorization failed.", error);
    return { categories: fallbackMemoryCategories(memories), usedModel: false };
  }
}

function exampleDailyReport() {
  return {
    headline: "You showed up today.",
    encouragement:
      "You did great. Even opening the loop counts: you gave the day somewhere softer to land.",
    observations: [
      "A scattered thought became visible instead of staying in your head.",
      "There is enough here to choose one next step without judging the whole day.",
      "Returning to the system is the win, even before anything is finished.",
    ],
    threads: [
      {
        label: "Scatter",
        detail: "Thoughts are being captured before they need to be organized.",
      },
      {
        label: "Flow",
        detail: "One small focus can be enough for a real day.",
      },
      {
        label: "Kind reframe",
        detail: "You are not starting over; you are returning.",
      },
    ],
    carryForward: "Showing up counts.",
  };
}

function parseDateWindow(sinceValue: string | null, untilValue: string | null) {
  if (!sinceValue || !untilValue) {
    return null;
  }

  const since = new Date(sinceValue);
  const until = new Date(untilValue);

  if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime()) || since >= until) {
    return null;
  }

  return { since, until };
}

async function generateDailyReport(userId: string, window?: { since: Date; until: Date }) {
  const [memories, task] = await Promise.all([
    loadScatterMemories(userId, 12, window),
    loadOpenTask(userId),
  ]);
  const memoryWindowLabel = window ? "today" : "recently";

  if (memories.length === 0 && !task) {
    return { report: exampleDailyReport(), usedModel: false, example: true };
  }

  if (!hasUsableCredentials()) {
    const report = exampleDailyReport();
    return {
      report: {
        ...report,
        observations: [
          `${memories.length} Scatter thought${memories.length === 1 ? "" : "s"} saved ${memoryWindowLabel}.`,
          task ? `Current Flow focus: ${task.title}.` : "Flow is ready when you pick a thought.",
          "You showed up by making the invisible visible.",
        ],
      },
      usedModel: false,
      example: false,
    };
  }

  const prompt = [
    "Create a gentle daily map for a Starflow user from Scatter memories and Flow state.",
    "Avoid clinical labels. Do not mention diagnosis. Be warm, concrete, and brief.",
    "Include encouragement like: you did great, you showed up.",
    `Treat the Scatter memories as the user's ${memoryWindowLabel} activity.`,
    `Scatter memories:\n${
      memories.length > 0
        ? memories.map((memory) => `- ${memorySnippet(memory.content)}`).join("\n")
        : "- none yet"
    }`,
    task
      ? `Flow task: ${task.title}\nSteps: ${task.steps
          .map((step) => `${step.done ? "[done]" : "[open]"} ${step.content}`)
          .join("; ")}`
      : "Flow task: none yet",
  ].join("\n\n");

  try {
    const client = createClient();
    const response = await client.models.generateContent({
      model: modelName(),
      contents: prompt,
      config: {
        systemInstruction:
          "You synthesize a supportive daily report from user-owned app data. Return only JSON.",
        responseMimeType: "application/json",
        responseSchema: dailyReportSchema(),
        temperature: 0.35,
        maxOutputTokens: 1_400,
      },
    });
    const parsed = parseModelJson<{
      headline?: string;
      encouragement?: string;
      observations?: string[];
      threads?: Array<{ label?: string; detail?: string }>;
      carry_forward?: string;
    }>(modelResponseText(response));
    const fallback = exampleDailyReport();

    return {
      report: {
        headline: parsed.headline?.trim() || fallback.headline,
        encouragement: parsed.encouragement?.trim() || fallback.encouragement,
        observations:
          parsed.observations
            ?.filter((item): item is string => typeof item === "string")
            .slice(0, 4) ?? fallback.observations,
        threads:
          parsed.threads
            ?.map((thread) => ({
              label: thread.label?.trim() || "Signal",
              detail: thread.detail?.trim() || "Something worth noticing showed up.",
            }))
            .slice(0, 4) ?? fallback.threads,
        carryForward: parsed.carry_forward?.trim() || fallback.carryForward,
      },
      usedModel: true,
      example: false,
    };
  } catch (error) {
    logServerError("Daily report generation failed.", error);
    return { report: exampleDailyReport(), usedModel: false, example: true };
  }
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
  whyItMatters,
  steps,
}: {
  taskId: string;
  title?: string;
  whyItMatters?: string | null;
  userId: string;
  steps?: string[];
}) {
  await db.transaction(async (tx) => {
    if (title || whyItMatters !== undefined) {
      await tx
        .update(tasks)
        .set({
          ...(title ? { title } : {}),
          ...(whyItMatters !== undefined ? { whyItMatters } : {}),
        })
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

function stringArg(args: Record<string, unknown> | undefined, key: string): string | null {
  const value = args?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function numberArg(args: Record<string, unknown> | undefined, key: string): number | null {
  const value = args?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanArg(args: Record<string, unknown> | undefined, key: string): boolean | null {
  const value = args?.[key];
  return typeof value === "boolean" ? value : null;
}

function stepsArg(args: Record<string, unknown> | undefined): string[] | null {
  const rawSteps = args?.steps;

  if (!Array.isArray(rawSteps)) {
    return null;
  }

  const steps = rawSteps
    .filter((step): step is string => typeof step === "string")
    .map((step) => step.trim())
    .filter(Boolean)
    .slice(0, 10);

  return steps.length > 0 ? steps : null;
}

function focusToolDeclarations(): FunctionDeclaration[] {
  return [
    {
      name: "rewrite_task",
      description:
        "Rename or repurpose the active task. Use when the user asks to change what they are working on.",
      parametersJsonSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          why_it_matters: { type: "string" },
          steps: {
            type: "array",
            description:
              "Optional 4 to 6 replacement steps when the task meaning changes substantially.",
            items: { type: "string" },
          },
        },
        required: ["title"],
      },
    },
    {
      name: "replace_steps",
      description:
        "Replace the whole step list with 5 to 9 ordered, concrete, domain-specific micro-steps.",
      parametersJsonSchema: {
        type: "object",
        properties: {
          steps: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: ["steps"],
      },
    },
    {
      name: "add_step",
      description: "Add one step after the given zero-based position, or at the end.",
      parametersJsonSchema: {
        type: "object",
        properties: {
          content: { type: "string" },
          after_position: { type: "number" },
        },
        required: ["content"],
      },
    },
    {
      name: "edit_step",
      description: "Rewrite one existing step by step id.",
      parametersJsonSchema: {
        type: "object",
        properties: {
          step_id: { type: "string" },
          content: { type: "string" },
        },
        required: ["step_id", "content"],
      },
    },
    {
      name: "remove_step",
      description: "Remove one existing step by step id.",
      parametersJsonSchema: {
        type: "object",
        properties: {
          step_id: { type: "string" },
        },
        required: ["step_id"],
      },
    },
    {
      name: "shrink_step",
      description:
        "Replace an overwhelming step with a smaller first action. The content must be the smaller action.",
      parametersJsonSchema: {
        type: "object",
        properties: {
          step_id: { type: "string" },
          content: { type: "string" },
        },
        required: ["step_id", "content"],
      },
    },
    {
      name: "complete_step",
      description: "Mark one existing step done or not done by step id.",
      parametersJsonSchema: {
        type: "object",
        properties: {
          step_id: { type: "string" },
          done: { type: "boolean" },
        },
        required: ["step_id", "done"],
      },
    },
  ];
}

function captureToolDeclarations(): FunctionDeclaration[] {
  return [
    {
      name: "set_capture_text",
      description: "Replace the current capture text with a clearer user-owned version.",
      parametersJsonSchema: {
        type: "object",
        properties: {
          text: { type: "string" },
        },
        required: ["text"],
      },
    },
    {
      name: "triage_now",
      description: "Turn the current capture text into a task and step list now.",
      parametersJsonSchema: {
        type: "object",
        properties: {
          text: { type: "string" },
        },
      },
    },
  ];
}

function reflectToolDeclarations(): FunctionDeclaration[] {
  return [
    {
      name: "set_carry_forward",
      description: "Set the reflection value the user wants to carry into tomorrow.",
      parametersJsonSchema: {
        type: "object",
        properties: {
          value: { type: "string" },
        },
        required: ["value"],
      },
    },
  ];
}

function toolDeclarationsForAgent(agent: AgentRole): FunctionDeclaration[] {
  if (agent === "focus") {
    return focusToolDeclarations();
  }

  if (agent === "capture") {
    return captureToolDeclarations();
  }

  if (agent === "reflect") {
    return reflectToolDeclarations();
  }

  return [];
}

function assertOwnedStep(
  ownedTask: Awaited<ReturnType<typeof loadOwnedTask>>,
  stepId: string | null,
) {
  if (!ownedTask || !stepId) {
    throw new Error("Step not found.");
  }

  const step = ownedTask.steps.find((candidate) => candidate.id === stepId);

  if (!step) {
    throw new Error("Step not found.");
  }

  return step;
}

async function createTaskFromText(userId: string, text: string) {
  const extracted = await generateTriage(text);
  const tinySteps = normalizeSteps(extracted.tiny_steps);
  const title = extracted.main_quest?.title?.trim() || "Choose the next small move";
  const whyItMatters = extracted.main_quest?.why_it_matters?.trim() || null;
  const otherTasks = Array.isArray(extracted.other_tasks) ? extracted.other_tasks : [];

  return db.transaction(async (tx) => {
    const [dump] = await tx
      .insert(brainDumps)
      .values({
        userId,
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
        userId,
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
}

function captureTextFromContext(uiContext: unknown): string | null {
  if (!uiContext || typeof uiContext !== "object") {
    return null;
  }

  const value = (uiContext as { dumpText?: unknown }).dumpText;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

async function executeAgentTool({
  call,
  ownedTask,
  uiContext,
  user,
}: {
  call: FunctionCall;
  ownedTask: Awaited<ReturnType<typeof loadOwnedTask>>;
  uiContext: unknown;
  user: CurrentUser;
}): Promise<{
  response: Record<string, unknown>;
  task: Awaited<ReturnType<typeof loadOpenTask>>;
  uiPatch: Record<string, unknown>;
}> {
  const name = call.name ?? "";
  const args = call.args ?? {};
  const uiPatch: Record<string, unknown> = {};
  let task = ownedTask?.payload ?? null;

  if (name === "set_capture_text") {
    const text = stringArg(args, "text");

    if (!text) {
      throw new Error("set_capture_text requires text.");
    }

    uiPatch.captureText = text;
    return { response: { ok: true, captureText: text }, task, uiPatch };
  }

  if (name === "triage_now") {
    const text = stringArg(args, "text") ?? captureTextFromContext(uiContext);

    if (!text) {
      throw new Error("triage_now requires text.");
    }

    task = await createTaskFromText(user.id, text);
    uiPatch.route = "focus";
    return { response: { ok: true, task }, task, uiPatch };
  }

  if (name === "set_carry_forward") {
    const value = stringArg(args, "value");

    if (!value) {
      throw new Error("set_carry_forward requires value.");
    }

    uiPatch.carryForward = value;
    return { response: { ok: true, carryForward: value }, task, uiPatch };
  }

  if (!ownedTask) {
    throw new Error("Focus tool requires a task.");
  }

  if (name === "rewrite_task") {
    const title = stringArg(args, "title");

    if (!title) {
      throw new Error("rewrite_task requires title.");
    }

    await updateTaskDetails({
      taskId: ownedTask.task.id,
      title,
      userId: user.id,
      ...(typeof args.why_it_matters === "string"
        ? { whyItMatters: args.why_it_matters.trim() || null }
        : {}),
    });
  } else if (name === "replace_steps") {
    const steps = stepsArg(args);

    if (!steps) {
      throw new Error("replace_steps requires steps.");
    }

    await updateTaskDetails({
      taskId: ownedTask.task.id,
      userId: user.id,
      steps,
    });
  } else if (name === "add_step") {
    const content = stringArg(args, "content");

    if (!content) {
      throw new Error("add_step requires content.");
    }

    const afterPosition = numberArg(args, "after_position");
    const insertPosition =
      afterPosition === null
        ? ownedTask.steps.length
        : Math.max(0, Math.min(ownedTask.steps.length, Math.floor(afterPosition) + 1));

    await db.transaction(async (tx) => {
      await tx
        .update(taskSteps)
        .set({ position: sql`${taskSteps.position} + 1` })
        .where(
          and(eq(taskSteps.taskId, ownedTask.task.id), gte(taskSteps.position, insertPosition)),
        );
      await tx.insert(taskSteps).values({
        taskId: ownedTask.task.id,
        content,
        position: insertPosition,
      });
    });
  } else if (name === "edit_step" || name === "shrink_step") {
    const step = assertOwnedStep(ownedTask, stringArg(args, "step_id"));
    const content = stringArg(args, "content");

    if (!content) {
      throw new Error(`${name} requires content.`);
    }

    await db.update(taskSteps).set({ content }).where(eq(taskSteps.id, step.id));
  } else if (name === "remove_step") {
    const step = assertOwnedStep(ownedTask, stringArg(args, "step_id"));
    await db.delete(taskSteps).where(eq(taskSteps.id, step.id));
  } else if (name === "complete_step") {
    const step = assertOwnedStep(ownedTask, stringArg(args, "step_id"));
    const done = booleanArg(args, "done");

    if (done === null) {
      throw new Error("complete_step requires done.");
    }

    await db.update(taskSteps).set({ done }).where(eq(taskSteps.id, step.id));
  } else {
    throw new Error(`Unknown tool: ${name}`);
  }

  const reloaded = await loadOwnedTask(user.id, ownedTask.task.id);
  task = reloaded?.payload ?? task;
  uiPatch.taskUpdated = true;
  return {
    response: {
      ok: true,
      task,
      ...(name === "rewrite_task"
        ? {
            nextActionHint:
              "If the current steps no longer match the rewritten task, call replace_steps before replying.",
          }
        : {}),
    },
    task,
    uiPatch,
  };
}

const app = new Hono();

app.onError((error, c) => {
  if (error instanceof SyntaxError) {
    return c.json({ error: "Malformed JSON body." }, 400);
  }

  logServerError("Unhandled request error.", error);
  return c.json({ error: "Unexpected server error." }, 500);
});

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
    const payload = await createTaskFromText(user.id, text);
    return c.json({ task: payload });
  } catch (error) {
    logServerError("Triage failed.", error);
    return c.json({ error: "Starflow could not untangle that dump. Try a shorter version." }, 502);
  }
});

app.post("/api/memories", async (c) => {
  const user = await requireUser(c);

  if (!user) {
    return c.json({ error: "Sign in before saving a scatter memory." }, 401);
  }

  const body = await c.req.json<{ text?: unknown }>();

  if (typeof body.text !== "string" || body.text.trim().length === 0) {
    return c.json({ error: "Scatter text is required." }, 400);
  }

  const text = body.text.trim();

  if (text.length > MAX_PROMPT_LENGTH) {
    return c.json({ error: `Scatter text must be ${MAX_PROMPT_LENGTH} characters or fewer.` }, 400);
  }

  const [memory] = await db
    .insert(agentMemories)
    .values({
      userId: user.id,
      sourceKind: "manual",
      content: text,
      metadata: { surface: "scatter" },
    })
    .returning();

  if (!memory) {
    throw new Error("Memory insert did not return a row.");
  }

  memoryCategoryCache.delete(user.id);

  const memoryState = await loadMemoryState(user.id);
  return c.json({
    memory: {
      id: memory.id,
      content: memory.content,
      createdAt: memory.createdAt.toISOString(),
    },
    memoryState,
  });
});

app.post("/api/capture/photo", async (c) => {
  const user = await requireUser(c);

  if (!user) {
    return c.json({ error: "Sign in before saving a photo memory." }, 401);
  }

  const body = await c.req.json<{ imageDataUrl?: unknown }>();

  if (typeof body.imageDataUrl !== "string" || body.imageDataUrl.length === 0) {
    return c.json({ error: "Photo data is required." }, 400);
  }

  if (body.imageDataUrl.length > 10_000_000) {
    return c.json({ error: "Photo is too large. Try a smaller image." }, 413);
  }

  const image = parseImageDataUrl(body.imageDataUrl);

  if (!image) {
    return c.json({ error: "Photo must be a PNG, JPEG, or WebP data URL." }, 400);
  }

  if (!hasUsableCredentials()) {
    return c.json(
      { error: "Gemini is not configured yet. Photo capture needs a Gemini key." },
      503,
    );
  }

  try {
    const client = createClient();
    const contents: Content[] = [
      {
        role: "user",
        parts: [
          {
            text: [
              "Read this photo as a Starflow Scatter capture.",
              "Write one concise first-person memory text that captures what the user may want to remember or act on.",
              "Do not diagnose. If the image is ambiguous, describe the visible scene neutrally.",
            ].join(" "),
          },
          { inlineData: { mimeType: image.mimeType, data: image.data } },
        ],
      },
    ];
    const response = await client.models.generateContent({
      model: modelName(),
      contents,
      config: {
        systemInstruction:
          "You are Record and Translate for an ADHD support app. Convert image context into a clear saved thought. Return only JSON.",
        responseMimeType: "application/json",
        responseSchema: photoCaptureSchema(),
        temperature: 0.25,
        maxOutputTokens: 600,
      },
    });
    const parsed = parseModelJson<{ memory_text?: string; note?: string }>(
      modelResponseText(response),
    );
    const content =
      parsed.memory_text?.trim() ||
      "I captured a photo and want Starflow to remember what it shows.";
    const note = parsed.note?.trim() || "Photo saved to Scatter memory.";
    const [memory] = await db
      .insert(agentMemories)
      .values({
        userId: user.id,
        sourceKind: "manual",
        content,
        metadata: { surface: "scatter", modality: "photo", note },
      })
      .returning();

    if (!memory) {
      throw new Error("Photo memory insert did not return a row.");
    }

    memoryCategoryCache.delete(user.id);

    const memoryState = await loadMemoryState(user.id);
    return c.json({
      memory: {
        id: memory.id,
        content: memory.content,
        createdAt: memory.createdAt.toISOString(),
      },
      memoryState,
      note,
    });
  } catch (error) {
    logServerError("Photo capture failed.", error);
    return c.json({ error: "Starflow could not read that photo. Try another image." }, 502);
  }
});

app.get("/api/memories/categorized", async (c) => {
  const user = await requireUser(c);

  if (!user) {
    return c.json({ error: "Sign in before viewing Scatter memories." }, 401);
  }

  const memoryState = await loadMemoryState(user.id);
  const cached = memoryCategoryCache.get(user.id);

  if (
    cached &&
    cached.total === memoryState.count &&
    cached.latestId === memoryState.latest?.id &&
    cached.expiresAt > Date.now()
  ) {
    return c.json({
      total: cached.total,
      categories: cached.categories,
      usedModel: cached.usedModel,
      model: cached.model,
      cached: true,
    });
  }

  const memories = await loadScatterMemories(user.id);
  const result = await categorizeMemories(memories);
  const payload = {
    total: memories.length,
    categories: result.categories,
    usedModel: result.usedModel,
    model: result.usedModel ? modelName() : null,
  };

  memoryCategoryCache.set(user.id, {
    ...payload,
    latestId: memoryState.latest?.id ?? null,
    expiresAt: Date.now() + 5 * 60 * 1000,
  });

  return c.json({
    ...payload,
    cached: false,
  });
});

app.get("/api/state", async (c) => {
  const user = await requireUser(c);

  if (!user) {
    return c.json({ error: "Sign in before loading Starflow state." }, 401);
  }

  const [task, reflection, memory] = await Promise.all([
    loadOpenTask(user.id),
    loadReflectionState(user.id),
    loadMemoryState(user.id),
  ]);
  return c.json({ task, reflection, memory });
});

app.get("/api/reflect/report", async (c) => {
  const user = await requireUser(c);

  if (!user) {
    return c.json({ error: "Sign in before loading your reflection map." }, 401);
  }

  const url = new URL(c.req.url);
  const window = parseDateWindow(url.searchParams.get("since"), url.searchParams.get("until"));
  const result = await generateDailyReport(user.id, window ?? undefined);
  return c.json(result);
});

app.get("/api/reflections", async (c) => {
  const user = await requireUser(c);

  if (!user) {
    return c.json({ error: "Sign in before loading reflections." }, 401);
  }

  return c.json({ reflections: await loadReflections(user.id) });
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
        maxOutputTokens: 2_000,
      },
    });
    const parsed = parseModelJson<{
      summary?: string;
      pattern?: string;
      small_win?: string;
      tomorrow_experiment?: string;
    }>(modelResponseText(response));
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
        maxOutputTokens: 2_000,
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
    }>(modelResponseText(response));

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

  const uiContext = body.uiContext;
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

  if (!hasUsableCredentials()) {
    return c.json({ error: "Gemini is not configured yet." }, 503);
  }

  const roleInstruction = {
    landing:
      "You are the Starflow landing-page concierge. Be elegant, brief, and invite the user toward the capture loop. You may suggest route='capture' when they want to try it.",
    signin:
      "You are the Starflow sign-in guide. Be calm and practical. Explain demo mode vs Google sign-in in one or two sentences. Never pretend to authenticate the user.",
    capture:
      "You are Record and Translate. Convert voice/image/text-like mess into clear user-owned words without prioritizing yet. Use set_capture_text when the user asks to rewrite the dump. Use triage_now when they ask to turn it into a task.",
    focus:
      "You are Receiving Adjustments and Changing Tasks, with Prioritization and Breakdown support. Use tools for visible task changes. If the user asks to change, replace, rename, or adjust the task, call rewrite_task. If they ask to redo the todo list, plan, recipe, or steps, call replace_steps with real domain-specific steps. If they say a step is too much, call shrink_step.",
    reflect:
      "You are Prioritizer for reflection. Help the user notice one meaningful signal from the day and choose what to carry tomorrow. Use set_carry_forward when the user explicitly names what to carry.",
  }[agent];

  const userLabel = user.displayName?.trim() || (user.isDemo ? "demo user" : "signed-in user");

  const prompt = [
    `Agent: ${agent}`,
    `Instruction: ${roleInstruction}`,
    "Agent boundaries: Context normalizes available context; Task Extraction detects actionable tasks; Prioritization ranks selected active tasks; Breakdown rewrites executable subtasks. Do not invent unrelated work.",
    "Mutation rule: when the user asks for a visible task/list change, call a tool instead of only chatting about it.",
    "Step-list rule: replacement step lists should contain 4 to 6 short ordered steps. Make them specific, but avoid over-explaining.",
    "Example: if the active task is a recipe and the user says 'change it to pasta and update the todo list', call rewrite_task and replace_steps with real pasta steps.",
    `User: ${userLabel}`,
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
    const toolDeclarations = toolDeclarationsForAgent(agent);
    let updatedTask = ownedTask?.payload ?? null;
    const uiPatch: Record<string, unknown> = {};

    if (toolDeclarations.length > 0) {
      let contents: Content[] = [{ role: "user", parts: [{ text: prompt }] }];
      let reply = "";

      for (let round = 0; round < 3; round += 1) {
        const response = await client.models.generateContent({
          model: modelName(),
          contents,
          config: {
            systemInstruction:
              "You are a Starflow page-specific agent. Respect the page role. Use declared tools for UI or database changes. Be brief and do not invent hidden state.",
            toolConfig: {
              functionCallingConfig: {
                mode: FunctionCallingConfigMode.AUTO,
              },
            },
            tools: [{ functionDeclarations: toolDeclarations }],
            temperature: 0.45,
            maxOutputTokens: 2_000,
          },
        });
        const functionCalls = response.functionCalls ?? [];

        if (functionCalls.length === 0) {
          reply = modelResponseText(response) ?? "";
          break;
        }

        const functionResponseParts = [];
        const modelParts =
          response.candidates?.[0]?.content?.parts ??
          functionCalls.map((call) => ({ functionCall: call }));

        for (const call of functionCalls) {
          let response: Record<string, unknown>;

          try {
            const result = await executeAgentTool({
              call,
              ownedTask,
              uiContext,
              user,
            });

            Object.assign(uiPatch, result.uiPatch);
            updatedTask = result.task ?? updatedTask;
            if (ownedTask) {
              ownedTask = (await loadOwnedTask(user.id, ownedTask.task.id)) ?? ownedTask;
            }
            response = result.response;
          } catch (error) {
            response = {
              ok: false,
              error: error instanceof Error ? error.message : "Tool call failed.",
            };
          }

          functionResponseParts.push({
            functionResponse: {
              name: call.name ?? "unknown_tool",
              response,
            },
          });
        }

        contents = [
          ...contents,
          {
            role: "model",
            parts: modelParts,
          },
          { role: "user", parts: functionResponseParts },
        ];
      }

      if (!reply) {
        try {
          const finalResponse = await client.models.generateContent({
            model: modelName(),
            contents,
            config: {
              systemInstruction:
                "Write one concise Starflow reply after the tools ran. Mention what changed only if useful. Do not output JSON.",
              temperature: 0.35,
              maxOutputTokens: 800,
            },
          });
          reply = modelResponseText(finalResponse) ?? "";
        } catch (error) {
          if (updatedTask || Object.keys(uiPatch).length > 0) {
            logServerError("Final chat reply failed after tools ran.", error);
            reply = "Done. I updated the screen.";
          } else {
            throw error;
          }
        }
      }

      return c.json({
        reply: reply || "Done. I updated the screen.",
        uiPatch,
        task: updatedTask,
      });
    }

    const firstResponse = await client.models.generateContent({
      model: modelName(),
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        systemInstruction:
          "You are a Starflow page-specific agent. Respect the page role. Use declared tools for UI or database changes. Be brief and do not invent hidden state.",
        responseMimeType: "application/json",
        responseSchema: chatSchema(),
        temperature: 0.45,
        maxOutputTokens: 2_000,
      },
    });

    const parsed = parseModelJson<{
      reply?: string;
      capture_text?: string | null;
      carry_forward?: string | null;
      route?: string | null;
    }>(modelResponseText(firstResponse));

    if (agent === "capture" && parsed.capture_text) {
      uiPatch.captureText = parsed.capture_text;
    }

    if (agent === "reflect" && parsed.carry_forward) {
      uiPatch.carryForward = parsed.carry_forward;
    }

    if (agent === "landing" && parsed.route === "capture") {
      uiPatch.route = "capture";
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
  idleTimeout: 60,
  fetch: app.fetch,
});

const startupConfig = geminiConfig();

// biome-ignore lint/suspicious/noConsole: Startup logging is useful in Cloud Run logs.
console.log(
  `Starflow API listening on http://0.0.0.0:${port} (${startupConfig.provider}, ${startupConfig.credentialSource})`,
);
