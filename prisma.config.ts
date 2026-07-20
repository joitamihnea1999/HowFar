import "dotenv/config";
import { defineConfig } from "prisma/config";

// `prisma migrate dev` needs a shadow database. Local Docker pre-creates the
// pinned sibling database with PostGIS available; cloud development may supply
// an explicit SHADOW_DATABASE_URL. `migrate deploy` never uses the shadow DB.
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
    shadowDatabaseUrl:
      process.env["SHADOW_DATABASE_URL"] ?? shadowUrl(process.env["DATABASE_URL"]),
  },
});
