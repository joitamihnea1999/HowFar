/** Result of racing a promise against a deadline. */
export type TimedResult<T> = { ok: true; value: T } | { ok: false; reason: "timeout" | "error"; error?: unknown };

/**
 * Race `promise` against `ms` milliseconds. Never throws — health probes must
 * degrade to a status, not hang or crash the route.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<TimedResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<TimedResult<T>>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason: "timeout" }), ms);
  });
  try {
    const value = await Promise.race([promise.then((v): TimedResult<T> => ({ ok: true, value: v })), deadline]);
    return value;
  } catch (error) {
    return { ok: false, reason: "error", error };
  } finally {
    clearTimeout(timer);
  }
}
