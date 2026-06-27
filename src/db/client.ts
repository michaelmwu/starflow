import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

function envValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

function databaseUrl(): string {
  const url = envValue("DATABASE_URL");

  if (url) {
    return url;
  }

  if (isProduction()) {
    throw new Error("DATABASE_URL is required in production.");
  }

  const user = envValue("POSTGRES_USER") ?? "agent_app";
  const password = envValue("POSTGRES_PASSWORD") ?? "agent_app";
  const host = envValue("POSTGRES_HOST_BIND") ?? envValue("POSTGRES_HOST") ?? "127.0.0.1";
  const port = envValue("POSTGRES_HOST_PORT") ?? "55432";
  const database = envValue("POSTGRES_DB") ?? "agent_context";

  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}`;
}

export const queryClient = postgres(databaseUrl(), {
  max: 5,
  prepare: false,
});

export const db = drizzle(queryClient, { schema });
