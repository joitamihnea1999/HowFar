import "dotenv/config";
import { defineConfig } from "prisma/config";

// `prisma migrate dev` needs a shadow database. We pin its name (same server)
// so the dev MySQL user can be granted rights on exactly `howfar.*` and
// `howfar_shadow.*` instead of instance-wide privileges (docker/mysql-init).
// `migrate deploy` (CI/Railway) never uses a shadow database.
function shadowUrl(databaseUrl: string | undefined): string | undefined {
  if (!databaseUrl) return undefined;
  try {
    const url = new URL(databaseUrl);
    url.pathname = "/howfar_shadow";
    return url.toString();
  } catch {
    return undefined;
  }
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env["DATABASE_URL"],
    shadowDatabaseUrl: shadowUrl(process.env["DATABASE_URL"]),
  },
});
