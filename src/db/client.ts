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

function makeClient(): ReturnType<typeof postgres> {
  const sharedOpts = { max: 5, prepare: false } as const;

  // Cloud SQL Auth Proxy socket: CLOUD_SQL_INSTANCE = project:region:instance
  // Cloud Run attaches the socket at /cloudsql/<CLOUD_SQL_INSTANCE>
  const cloudSqlInstance = envValue("CLOUD_SQL_INSTANCE");
  if (cloudSqlInstance) {
    const cloudSqlUser = envValue("CLOUD_SQL_USER");
    const cloudSqlPassword = envValue("CLOUD_SQL_PASSWORD");
    const cloudSqlDatabase = envValue("CLOUD_SQL_DATABASE");

    if (isProduction() && (!cloudSqlUser || !cloudSqlPassword || !cloudSqlDatabase)) {
      throw new Error(
        "CLOUD_SQL_USER, CLOUD_SQL_PASSWORD, and CLOUD_SQL_DATABASE are required when CLOUD_SQL_INSTANCE is set in production.",
      );
    }

    return postgres({
      ...sharedOpts,
      host: `/cloudsql/${cloudSqlInstance}`,
      user: cloudSqlUser ?? "agent_app",
      password: cloudSqlPassword ?? "",
      database: cloudSqlDatabase ?? "agent_context",
    });
  }

  const url = envValue("DATABASE_URL");
  if (url) {
    return postgres(url, sharedOpts);
  }

  if (isProduction()) {
    throw new Error("DATABASE_URL or CLOUD_SQL_INSTANCE is required in production.");
  }

  const user = envValue("POSTGRES_USER") ?? "agent_app";
  const password = envValue("POSTGRES_PASSWORD") ?? "agent_app";
  const host = envValue("POSTGRES_HOST_BIND") ?? envValue("POSTGRES_HOST") ?? "127.0.0.1";
  const port = Number(envValue("POSTGRES_HOST_PORT") ?? "55432");
  const database = envValue("POSTGRES_DB") ?? "agent_context";

  return postgres({ ...sharedOpts, host, port, user, password, database });
}

export const queryClient = makeClient();

export const db = drizzle(queryClient, { schema });
