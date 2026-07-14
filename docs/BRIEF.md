# HowFar — Neighborhood Livability Explorer

**Build Brief**

> Note: §"Working title" says *Habita (provisional)* — the product name was subsequently
> fixed as **HowFar**, which supersedes Habita everywhere.

This brief defines what to build, why, the scope, and the fixed technical setup required for the project. It deliberately does not prescribe how to implement anything — implementation decisions, architecture, and code are left open. Where a technology is listed, it is a requirement, not a suggestion. Where free-tier limits are mentioned, treat them as unverified — confirm before relying on them (do not assume specific numbers).

Working title: Habita (provisional). Launch market: Bucharest first.

## 1. What it is

A web app that turns any address into an instant, visual "how good is it to live here?" report — built entirely on free, public data, requiring no user data entry beyond a single address.

The user pastes an address (a flat they're considering, or a workplace). The app shows, on a full-screen map: everywhere reachable within 15 / 30 / 45 minutes by foot, public transport, bike, and car (isochrones); nearby amenities (shops, parks, schools, pharmacies, transit); a livability score with a transparent breakdown; and a short air-quality + climate summary.

## 2. The problem it solves

When people move, rent, or weigh a job offer, listing sites and generic maps answer the wrong question (price, district, single-destination directions). The decisive questions — can I reach what I care about quickly? what's within walking distance? is the area healthy? — go unanswered as a single, visual synthesis for an arbitrary address. That gap causes real post-move regret. HowFar fills it.

## 3. Purpose & success criteria

This is primarily a portfolio / hiring project. It succeeds if it is:

- **Visually striking — this is the top priority.** It must impress within seconds of landing (the map + animated isochrone reveal); it must look great in a single screenshot.
- Deployed live at a public URL with a custom domain (clickable from a CV).
- A real, useful product solving the problem above.
- Technically credible — geospatial computation, orchestration of multiple public data sources, a real caching layer, clean data modeling, auth, and automated tests.
- Shippable solo in a few weeks (owner is job-hunting; time is limited).
- Owned end-to-end — demonstrates the owner conceiving, designing, and delivering a whole product, not just implementing a spec.

## 4. Target users & scenarios

- Flat-hunters / relocators evaluating candidate addresses they already found elsewhere.
- People weighing a job offer (commute + neighbourhood from home ↔ office).
- Anyone comparing neighbourhoods.

Typical: "I found 3 flats — which has the best commute and most amenities within walking distance?" · "From my home, how bad is the commute to this new job by transit vs car?" · "Which area has schools, a park, and a pharmacy within a 15-min walk?"

## 5. Positioning

Complementary to listing sites (it evaluates addresses the user found there; it does not host or compete on listings). Its edge over generic maps: multi-modal isochrones + amenity synthesis + a livability score + a shareable visual, for an arbitrary address, free and Bucharest-first. It relies only on public data, so there is no data to acquire, no crowd/network-effect needed, and no AI acting as a trusted content engine.

## 6. Scope

### Must build (v1 / MVP) — Bucharest

- Single-field address search with geocoding + result disambiguation.
- Isochrones for at least walking + public transport at 15 / 30 / 45 min, rendered as map layers (other modes later).
- Nearby amenities for core categories: groceries/supermarkets, pharmacies, parks/green space, schools, transit stops — shown on the map, with counts within the walking isochrone.
- A livability score (0–100) with a transparent, visible breakdown (see §8).
- An air-quality + climate summary for the location.
- Map UX: full-screen, layer toggles, legend, animated isochrone reveal, responsive desktop + mobile (touch-first).
- Accounts via social login (Google/GitHub).
- Saved searches, synced across devices for signed-in users.
- A shareable result URL that reproduces a report without login.

### Later (v2+)

- More travel modes + custom time thresholds; compare mode (2–3 addresses side by side); more amenity categories + user-weighted scoring; an optional, bounded AI assistant ("describe your ideal neighbourhood" → adjusts score weights); environmental-risk layers (flood/heat) only if a clean free source exists; additional cities; rich link-preview images.

### Out of scope

- Hosting/scraping property listings or prices; contacting agents.
- Real-time collaboration / multi-user / chat / social features.
- Native mobile apps.
- Anything requiring paid data or heavy self-hosted geo infrastructure.

## 7. Data (public sources only)

Requirement: all data comes from free, public sources; the app stores no listings and requires no user input beyond the address (+ optional preferences). All external calls happen server-side (keys never exposed client-side) and are cached to respect free-tier limits.

| Source | Provides | Access note |
| --- | --- | --- |
| Nominatim (OpenStreetMap) | Geocoding (address ↔ coordinates) | No key; strict usage policy |
| OpenRouteService | Isochrones (reachable-area polygons) | Free API key |
| Overpass (OpenStreetMap) | Amenities / POIs in an area | No key; fair-use |
| Open-Meteo | Weather / climate (and an air-quality option) | No key |
| OpenAQ | Air-quality measurements | API key (alternative/fallback for air) |
| Map tiles — MapTiler or Protomaps | Base map for MapLibre | MapTiler: key (free tier) · Protomaps: self-host |

> Verify each provider's current free-tier quotas and terms early; choose the geocoder and tile provider then. Respect provider ToS and show OpenStreetMap attribution.

## 8. Livability score

A composite 0–100 score derived from: reachability (isochrone coverage), amenity access (key POIs within the walking isochrone, with diminishing returns), green space, and environment (air quality / climate). Requirements: it must be deterministic, transparent (show a per-category breakdown so it never feels arbitrary), and tunable (defaults now; user-weighted / AI-assisted later). The exact rules are yours to design and iterate so the numbers feel right for known Bucharest neighbourhoods.

## 9. Required setup (fixed technical decisions)

| Layer | Required choice |
| --- | --- |
| Language | TypeScript (strict) |
| Framework | Next.js (App Router) — full-stack (UI + server) in one repo |
| Styling | Tailwind CSS |
| Map / visualisation | MapLibre GL; deck.gl for the high-impact visual layers (polish stage) |
| Database | MySQL — mandatory and central to the app |
| ORM | Prisma |
| Auth | Auth.js (NextAuth) with social login; users stored in the app's MySQL |
| Caching | MySQL-based (primary), per owner's "single store" preference; localStorage only for UI micro-state; Redis only if later justified by profiling |
| Hosting | Railway — app and MySQL, over private networking (app runs as a persistent server, not serverless) |
| Testing | Vitest (unit) + Playwright (at least one e2e), run in CI |
| AI (optional, late) | Anthropic API — bounded, advisory feature only |

Not Symfony/PHP for this project (the owner's backend strength is already proven elsewhere; a single full-stack TypeScript app is required here for speed and a single deploy).

## 10. Hard constraints & non-negotiables

- Public/free data only; no listings hosted or scraped; user enters only an address (+ optional preferences).
- MySQL is mandatory and central; no parallel data store (localStorage is for UI micro-state only).
- Desktop and mobile both first-class (touch-first map).
- Deployed live on Railway with a custom domain; publicly clickable.
- Automated tests + CI are required (this deliberately closes a gap in the owner's past projects).
- External API keys stay server-side; responses cached to stay within free tiers.
- AI is optional and advisory only — never the engine producing the core report.
- Launch scope = Bucharest.
- Core evaluation flow is usable without login; login is required only to save.
- Respect provider ToS; show OSM attribution.

## 11. Priorities & delivery order (objectives, not instructions)

- **M0 — Setup:** project scaffolded on the required stack; deployed empty on Railway with MySQL connected; CI green; provider quotas verified and geocoder/tile choices finalised.
- **M1 — Foundation:** persistence for users, saved searches, and cached API responses (with expiry); social auth working.
- **M2 — Core visual experience** (highest priority; this is the demo): address → isochrones (walking + transit) + nearby amenities + environment + transparent score, on a polished, responsive map, live and clickable.
- **M3 — Saved searches** synced across devices + shareable result URL.
- **M4 — Visual polish:** deck.gl layers, motion, dark mode, mobile bottom-sheet, accessibility; README with a GIF and the live link.
- **M5 — (optional)** bounded AI assistant for score weighting.
- Throughout: tests grow with features; README kept current; clean commit history.

## 12. Open questions to resolve early

- Current free-tier quotas/terms for each provider (blocks provider choices).
- Geocoder: Nominatim vs a hosted free-tier alternative.
- Map tiles: MapTiler vs self-hosted Protomaps.
- Air-quality source: Open-Meteo vs OpenAQ.
- v1 travel modes: confirm walking + public transport first.
- Product name + domain (~~Habita is provisional~~ → resolved: **HowFar**; domain still to be chosen/purchased by owner).
- Compare mode: v1 or v2.
