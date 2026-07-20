import { PrismaPg } from "@prisma/adapter-pg";
import type { PoolConfig } from "pg";

import { PrismaClient } from "@/generated/prisma/client";
import { serverEnv } from "@/lib/env";

// One PrismaClient per process; survive Next.js dev-mode hot reloads via globalThis.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * Explicit pg pool config keeps connection acquisition and SQL execution
 * bounded. node-postgres otherwise has no connection timeout, and a stalled
 * spatial query must not occupy a pool slot indefinitely.
 *
 * Exported for tests: a parsing regression here (credentials, port, database
 * name) is a production outage, so the mapping is pinned by db.test.ts.
 */
export function poolConfig(databaseUrl: string): PoolConfig {
  return {
    connectionString: databaseUrl,
    application_name: "howfar",
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 10_000,
    statement_timeout: 10_000,
  };
}

function createClient(): PrismaClient {
  const adapter = new PrismaPg(poolConfig(serverEnv().databaseUrl));
  return new PrismaClient({ adapter });
}

export function db(): PrismaClient {
  globalForPrisma.prisma ??= createClient();
  return globalForPrisma.prisma;
}
