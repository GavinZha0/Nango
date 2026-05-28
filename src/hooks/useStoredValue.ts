"use client";

/**
 * useStoredValue — SSR-safe localStorage-backed value hook.
 *
 * Reads localStorage through `useSyncExternalStore` so:
 *   - The SSR snapshot is always the SSR-safe default (no localStorage
 *     access on the server). This is what hydration sees.
 *   - The client snapshot is the parsed localStorage value. After
 *     hydration React re-snapshots and the real value flows in.
 *   - There is no `setState`-in-effect (the project's strict
 *     `react-hooks/set-state-in-effect` rule forbids that).
 *
 * Same-tab writes (the typical case — user clicks a tab in this
 * component) go through the returned `write()` function, which sets
 * localStorage AND dispatches a custom CustomEvent on `window` so
 * every subscribed `useStoredValue` re-snapshots. Cross-tab updates
 * arrive via the native `storage` event.
 *
 * The hook is generic over T. Pass `parse` to convert the raw string
 * (or `null` if absent) into your type, and `serialize` to go the
 * other way. The default snapshot is the value `parse(null)` returns.
 */

import { useCallback, useRef, useSyncExternalStore } from "react";

interface UseStoredValueOptions<T> {
  /** localStorage key. */
  key: string;
  /** Convert the raw stored string (or `null` if not set) → T. */
  parse: (raw: string | null) => T;
  /** Convert T → string for storage. */
  serialize: (value: T) => string;
  /** The value rendered during SSR + the hydration commit. Must be a
   *  stable reference (same object on every call) so React can do
   *  cheap reference equality across renders. */
  serverDefault: T;
}

/**
 * Fire whenever a same-tab write happens for `key`. We listen for it
 * in addition to the native `storage` event (which only fires in
 * OTHER tabs, never the one that wrote the value).
 */
const SAME_TAB_EVENT = "nango:stored-value-write";

interface SameTabDetail {
  key: string;
}

export function useStoredValue<T>(opts: UseStoredValueOptions<T>): {
  value: T;
  write: (next: T) => void;
} {
  const { key, parse, serialize, serverDefault } = opts;

  const subscribe = useCallback(
    (onChange: () => void) => {
      function onStorage(e: StorageEvent) {
        if (e.key === key) onChange();
      }
      function onSameTab(e: Event) {
        if ((e as CustomEvent<SameTabDetail>).detail?.key === key) onChange();
      }
      window.addEventListener("storage", onStorage);
      window.addEventListener(SAME_TAB_EVENT, onSameTab);
      return () => {
        window.removeEventListener("storage", onStorage);
        window.removeEventListener(SAME_TAB_EVENT, onSameTab);
      };
    },
    [key],
  );

  // Cache the most recent `(raw, parsed)` pair. `useSyncExternalStore`
  // calls `getSnapshot()` on every render to compare against the
  // previous value; for object-shaped T (e.g. Set<string>) `parse()`
  // would produce a brand-new reference each call and React would
  // never bail out. By keying the cache off the raw localStorage
  // string we return the same parsed object as long as the underlying
  // storage hasn't changed.
  const cacheRef = useRef<{ raw: string | null; parsed: T } | null>(null);

  const getClientSnapshot = useCallback((): T => {
    let raw: string | null;
    try {
      raw = localStorage.getItem(key);
    } catch {
      return serverDefault;
    }
    const cached = cacheRef.current;
    if (cached && cached.raw === raw) return cached.parsed;
    const parsed = parse(raw);
    cacheRef.current = { raw, parsed };
    return parsed;
  }, [key, parse, serverDefault]);

  const getServerSnapshot = useCallback((): T => serverDefault, [serverDefault]);

  // useSyncExternalStore re-runs getClientSnapshot whenever the
  // subscribed `onChange` fires. The cache above guarantees stable
  // references so React's bailout works for both primitive and
  // object-shaped values.
  const value = useSyncExternalStore(
    subscribe,
    getClientSnapshot,
    getServerSnapshot,
  );

  const write = useCallback(
    (next: T) => {
      try {
        localStorage.setItem(key, serialize(next));
      } catch {
        /* quota / private mode — ignore */
      }
      // Notify same-tab subscribers; cross-tab subscribers get the
      // native `storage` event from the browser.
      const detail: SameTabDetail = { key };
      window.dispatchEvent(new CustomEvent(SAME_TAB_EVENT, { detail }));
    },
    [key, serialize],
  );

  return { value, write };
}
