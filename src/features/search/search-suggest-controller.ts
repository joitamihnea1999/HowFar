import {
  shouldFetchSuggest,
  type ComboboxAction,
  type ComboboxState,
  type Suggestion,
} from "@/features/search/combobox";

/**
 * The autocomplete debounce + fetch glue (tasks 013/020), split out of `AppMap`.
 * The combobox reducer owns every state transition; this controller owns only
 * the imperative bits — the debounce timer and the AbortController — and tags
 * each fetch with the generation current when it was scheduled so a superseded
 * response (or one after close/pick) is dropped by the reducer. `dispose`
 * cancels the timer and aborts any in-flight request.
 */
export function createSearchSuggestController({
  comboRef,
  dispatchCombo,
  debounceMs,
}: {
  comboRef: { current: ComboboxState };
  dispatchCombo: (action: ComboboxAction) => ComboboxState;
  debounceMs: number;
}) {
  let abort: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function runSuggest(generation: number, q: string) {
    // Defensive: a timer is always cleared before a new one is set, so this
    // should already hold — but never disturb a newer request's in-flight fetch.
    if (generation !== comboRef.current.generation) return;
    dispatchCombo({ type: "fetchStarted", generation });
    abort?.abort();
    const controller = new AbortController();
    abort = controller;
    fetch(`/api/suggest?q=${encodeURIComponent(q)}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) return void dispatchCombo({ type: "fetchError", generation });
        const data = (await res.json()) as { suggestions?: unknown };
        // A valid-but-wrong-shape body (no array) is an error, not "no matches" —
        // and must not reach the render, which reads `.length`.
        if (!Array.isArray(data.suggestions)) return void dispatchCombo({ type: "fetchError", generation });
        dispatchCombo({ type: "suggestionsLoaded", generation, suggestions: data.suggestions as Suggestion[] });
      })
      .catch((err) => {
        // A superseded/blurred request is aborted — leave its state to the newer
        // run. A genuine network/parse failure surfaces the error state so the
        // dropdown does not sit forever on "Searching…" (the reducer drops it if
        // the generation is already stale).
        if ((err as Error)?.name === "AbortError") return;
        dispatchCombo({ type: "fetchError", generation });
      });
  }

  /** Debounce a fetch for the given combobox state (no-op unless it should fetch). */
  function schedule(state: ComboboxState) {
    if (timer) clearTimeout(timer);
    if (!shouldFetchSuggest(state)) return;
    const generation = state.generation;
    const q = state.query.trim();
    timer = setTimeout(() => runSuggest(generation, q), debounceMs);
  }

  /** Cancel any in-flight fetch synchronously (a fresh keystroke supersedes it). */
  function abortInflight() {
    abort?.abort();
  }

  /** Stop the debounce timer AND abort the in-flight fetch (close / pick). */
  function cancel() {
    if (timer) clearTimeout(timer);
    abort?.abort();
  }

  return {
    schedule,
    abortInflight,
    cancel,
    dispose: cancel,
  };
}

export type SearchSuggestController = ReturnType<typeof createSearchSuggestController>;
