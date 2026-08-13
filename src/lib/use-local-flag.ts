"use client"

import { useCallback, useSyncExternalStore } from "react"

/**
 * A boolean kept in `localStorage`, read the way React wants external state read.
 *
 * The obvious version — `useState(false)` plus a `useEffect` that reads storage
 * on mount — is what this replaces. It works, but it is a lint error under
 * `react-hooks/set-state-in-effect` for a real reason: it renders once with the
 * wrong value and then immediately re-renders, so the UI visibly flips on load.
 * `useSyncExternalStore` gives the server a defined snapshot and the client the
 * true value on the first client render instead.
 *
 * Why `localStorage` at all, rather than a column: none of these flags are
 * worth a migration. The add-on's schema is an integration artefact that has to
 * apply verbatim to the host app, and "has this browser seen the tour" is not
 * something the host should inherit a column for. Nothing important depends on
 * them either — the checklist derives its content from the database and only
 * uses this to decide whether it is collapsed.
 *
 * The trade-off, stated plainly: these are per-browser, so the tour shows again
 * on a new device or after clearing site data. For a once-per-account welcome
 * that is an acceptable failure — it is a mild annoyance in the rare case, not
 * a correctness problem in the common one.
 */

/** `storage` only fires in OTHER tabs, so same-tab writes need their own event. */
const LOCAL_EVENT = "lifecycle:local-flag"

function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange)
  window.addEventListener(LOCAL_EVENT, onChange)
  return () => {
    window.removeEventListener("storage", onChange)
    window.removeEventListener(LOCAL_EVENT, onChange)
  }
}

function read(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1"
  } catch {
    // Safari in private mode throws on access rather than returning null.
    return false
  }
}

export function useLocalFlag(
  key: string,
  /** What to assume on the server and before storage can be read. */
  serverValue = false,
): [boolean, (next: boolean) => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => read(key),
    () => serverValue,
  )

  const set = useCallback(
    (next: boolean) => {
      try {
        if (next) window.localStorage.setItem(key, "1")
        else window.localStorage.removeItem(key)
      } catch {
        // Storage unavailable: the flag simply does not persist. Still dispatch,
        // so anything listening re-reads and stays consistent within the page.
      }
      window.dispatchEvent(new Event(LOCAL_EVENT))
    },
    [key],
  )

  return [value, set]
}
