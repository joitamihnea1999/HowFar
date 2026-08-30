// Next.js instrumentation hook — runs ONCE when the server process starts (task 017, gap #8).
// This is the correct home for provider warmup: process-start, not a request handler, and in
// particular NOT `/api/ready` (readiness must stay a bounded local probe).
export async function register() {
  // Node runtime only — the warmup touches the DB + ORS (server-only) and must never load into
  // the edge runtime. `register` also fires for the edge runtime, so guard on NEXT_RUNTIME.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Opt-out for environments that must not make provider calls at boot (kept simple: any truthy
  // value disables). Best-effort by default.
  if (process.env.HOWFAR_DISABLE_WARMUP) return;
  const { warmupProviders } = await import("@/features/amenities/server/warmup");
  // Fire-and-forget: warmup runs in the background and never blocks the server from becoming
  // ready, and `warmupProviders` swallows all errors internally, so nothing here can reject.
  void warmupProviders();
}
