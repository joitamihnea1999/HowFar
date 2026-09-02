/**
 * ApiCache reaper — delete expired cache rows. Run on a cadence in production.
 *
 * The app never deletes expired `ApiCache` rows on the read path (that would race
 * a concurrent refresh); this script is the production trigger. On the launch VPS,
 * schedule it hourly, e.g. a crontab line:
 *
 *   17 * * * * cd /srv/howfar && node --env-file=.env ./node_modules/.bin/tsx scripts/reap-cache.ts >> /var/log/howfar/reap.log 2>&1
 *
 * Ownership: ops / go-live checklist. Observability: prints a one-line JSON summary
 * (deleted rows + L1 purged) and exits non-zero only on an unexpected failure.
 * Idempotent and safe to overlap — each batch is an atomic conditional delete.
 *
 * USAGE:  node --env-file=.env ./node_modules/.bin/tsx scripts/reap-cache.ts
 *   (or `npm run reap:cache`)
 */

import { deleteExpired } from "@/lib/api-cache";

async function main(): Promise<number> {
  const startedAt = new Date().toISOString();
  const { deleted, l1Purged, errored, error } = await deleteExpired();
  console.log(JSON.stringify({ reaper: "api-cache", startedAt, deleted, l1Purged, errored, error }));
  // The sweep is best-effort in-process, but the CRON must SURFACE a failure —
  // a swallowed DB error would otherwise report a normal-looking success while
  // the table keeps growing (the very condition this reaper was added to fix).
  return errored ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`[reap-cache] failed: ${(err as Error).message}`);
    process.exit(1);
  });
