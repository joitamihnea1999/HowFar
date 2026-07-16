import { PrismaMariaDb } from "@prisma/adapter-mariadb";

import { PrismaClient } from "@/generated/prisma/client";
import { serverEnv } from "@/lib/env";

// One PrismaClient per process; survive Next.js dev-mode hot reloads via globalThis.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * mysql:// URL → mariadb pool config. Explicit config (instead of passing the
 * string through) lets us bound connect/acquire so an unreachable database
 * fails fast instead of hanging pool slots. A stalled in-flight query is still
 * unbounded (MySQL lacks a safe driver-side query timeout) — the pool cap and
 * the health probe's withTimeout keep that contained.
 *
 * Exported for tests: a parsing regression here (credentials, port, database
 * name) is a production outage, so the mapping is pinned by db.test.ts.
 */
export function poolConfig(databaseUrl: string) {
  const url = new URL(databaseUrl);
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ""),
    connectTimeout: 5_000,
    acquireTimeout: 5_000,
  };
}

function createClient(): PrismaClient {
  const adapter = new PrismaMariaDb(poolConfig(serverEnv().databaseUrl));
  return new PrismaClient({ adapter });
}

export function db(): PrismaClient {
  globalForPrisma.prisma ??= createClient();
  return globalForPrisma.prisma;
}
