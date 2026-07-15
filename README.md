# HowFar — Neighborhood Livability Explorer

Turn any Bucharest address into an instant, visual **"how good is it to live here?"** report:
isochrones (how far 15/30/45 minutes really take you on foot and by public transport), nearby
amenities, air quality, and a transparent 0–100 livability score — built entirely on free,
public data.

![HowFar — dark Bucharest basemap](docs/screenshot.png)

> **Status: M1 complete — live at
> [howfar-production-b31c.up.railway.app](https://howfar-production-b31c.up.railway.app).**
> M0 foundation (scaffold, self-hosted basemap rendering, MySQL + Auth.js, tests +
> [CI green](https://github.com/joitamihnea1999/HowFar/actions), deployed on Railway over
> private networking) plus M1: saved-search and expiring API-cache persistence, and working
> social sign-in. Custom domain: not yet attached.
> Address search, isochrones and scoring are next (M2 is the demo milestone). See
> [`docs/BRIEF.md`](docs/BRIEF.md) for the product brief and
> [`docs/PROVIDERS.md`](docs/PROVIDERS.md) for verified data-provider decisions.

## Stack

TypeScript (strict) · Next.js 16 (App Router, one full-stack repo) · Tailwind CSS 4 ·
MapLibre GL + self-hosted [Protomaps](https://protomaps.com) tiles · MySQL 8 + Prisma 7 ·
Auth.js v5 (Google/GitHub) · Vitest + Playwright · Railway

Data: Nominatim (geocoding) · OpenRouteService (walking isochrones) ·
[Transitous](https://transitous.org) / MOTIS (transit reachability) · Overpass (amenities) ·
Open-Meteo (climate + air quality). All calls server-side, MySQL-cached; the only secret is the
ORS key. Tiles are served from a 25 MB Bucharest extract by the app itself — **no client-side
API keys anywhere**.

## Local development

Requirements: Node 24.x (`.nvmrc`), Docker.

```bash
nvm use                     # Node 24.x (see .nvmrc)
npm ci                      # also runs prisma generate
docker compose up -d db     # MySQL 8.4 on localhost:3307
cp .env.example .env        # fill AUTH_SECRET (npx auth secret); defaults fit the compose DB
npx prisma migrate deploy   # create tables
npm run tiles:fetch         # one-time ~25MB Bucharest basemap extract
npm run dev                 # http://localhost:3000
```

### Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` / `build` / `start` | Next.js dev / production build / serve |
| `npm run lint` · `npm run typecheck` | ESLint · `tsc --noEmit` |
| `npm test` | Vitest unit suite |
| `npm run test:e2e` | Playwright smoke (needs `npm run build` first + DB up) |
| `npm run tiles:fetch [YYYYMMDD]` | (Re)fetch the Bucharest basemap extract |

### Health endpoints

- `GET /api/health` — liveness: always 200, reports `{ ok, db }` (DB probe bounded at 2 s).
- `GET /api/ready` — readiness: 200 only when MySQL is reachable, else 503. Used by the
  Railway healthcheck and Playwright's server gate.

## CI

`.github/workflows/ci.yml` runs on every push/PR: **lint → typecheck → unit → build**, plus an
**e2e job** with a MySQL 8.4 service, `prisma migrate deploy`, a cached basemap extract, and
Playwright against the production build.

## Deploying to Railway

`railway.json` is committed (build fetches tiles; start runs `prisma migrate deploy`;
healthcheck = `/api/ready`). One-time setup — **order matters**: connecting the repo triggers
an immediate deploy, and the start command's migration needs the database and env first.

1. Create an empty Railway project (Hobby plan — the Trial pauses after 30 days).
2. Add a **MySQL** service and wait for it to provision.
3. Create the app service **empty** (no source) and set its variables now:
   `DATABASE_URL` as a Railway variable *reference* to the MySQL service's
   **private-network** URL (`${{MySQL.MYSQL_URL}}` → `mysql.railway.internal`), and
   `AUTH_SECRET` (`npx auth secret`). Optional: `AUTH_GOOGLE_ID/SECRET`,
   `AUTH_GITHUB_ID/SECRET` (OAuth callback: `https://<domain>/api/auth/callback/<provider>`),
   `ORS_API_KEY`.
4. Only now connect this GitHub repo to the app service (auto-deploys `main`) and wait for
   the deploy to pass the `/api/ready` healthcheck. Generate a public URL
   (`railway domain`) or attach a custom domain.

## Attribution

Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors ·
Basemap tiles: [Protomaps](https://protomaps.com) ·
Transit routing: [Transitous](https://transitous.org/sources/) ·
Weather & air quality: [Open-Meteo](https://open-meteo.com) (CC BY 4.0) ·
Geocoding: [Nominatim](https://nominatim.org)
