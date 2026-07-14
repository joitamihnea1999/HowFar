# HowFar — Neighborhood Livability Explorer

Turn any Bucharest address into an instant, visual **"how good is it to live here?"** report:
isochrones (how far 15/30/45 minutes really take you on foot and by public transport), nearby
amenities, air quality, and a transparent 0–100 livability score — built entirely on free,
public data.

![HowFar — dark Bucharest basemap](docs/screenshot.png)

> **Status: M0 (setup) complete.** Stack scaffolded, self-hosted basemap rendering, MySQL +
> Auth.js wired, tests + CI in place, Railway deploy config ready. Address search, isochrones
> and scoring are next (M2 is the demo milestone). See [`docs/BRIEF.md`](docs/BRIEF.md) for the
> product brief and [`docs/PROVIDERS.md`](docs/PROVIDERS.md) for verified data-provider
> decisions.

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

Requirements: Node ≥ 22 (`.nvmrc`), Docker.

```bash
nvm use                     # or any Node 22+
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
healthcheck = `/api/ready`). One-time setup:

1. Create a Railway project from this GitHub repo (Hobby plan — the Trial pauses after 30 days).
2. Add a **MySQL** service; on the app service set
   `DATABASE_URL` to the MySQL service's **private-network** URL
   (`mysql://root:<pw>@mysql.railway.internal:3306/railway`).
3. Set `AUTH_SECRET` (`npx auth secret`). Optional: `AUTH_GOOGLE_ID/SECRET`,
   `AUTH_GITHUB_ID/SECRET` (OAuth callback: `https://<domain>/api/auth/callback/<provider>`),
   `ORS_API_KEY`.
4. Attach the custom domain, wait for the deploy to pass the `/api/ready` healthcheck.

## Attribution

Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors ·
Basemap tiles: [Protomaps](https://protomaps.com) ·
Transit routing: [Transitous](https://transitous.org/sources/) ·
Weather & air quality: [Open-Meteo](https://open-meteo.com) (CC BY 4.0) ·
Geocoding: [Nominatim](https://nominatim.org)
