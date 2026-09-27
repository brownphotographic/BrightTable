/*
 * BrightTable // Copyright (C) 2026 Rob Brown
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import { useEffect, useRef, useState } from 'react';

// Small per-machine UI conveniences (last tab, thumbnail size, the folder/
// album/person/tag last opened) remembered across launches in the webview's
// localStorage - deliberately not part of the synced config. Every access is
// guarded: storage can be unavailable, and losing one of these just means
// falling back to the default.
const PREFIX = 'brighttable.';

export function readPersisted(key: string): unknown {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function writePersisted(key: string, value: unknown) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Storage unavailable - just won't persist this session.
  }
}

/** useState whose value is restored on mount (if `isValid`) and saved on every change. */
export function usePersistedState<T>(key: string, fallback: T, isValid: (v: unknown) => v is T) {
  const [value, setValue] = useState<T>(() => {
    const saved = readPersisted(key);
    return isValid(saved) ? saved : fallback;
  });
  useEffect(() => writePersisted(key, value), [key, value]);
  return [value, setValue] as const;
}

/**
 * Persists a view's open item (folder path, album/person/tag id) - but only
 * restores it once `loaded` says the list it lives in has arrived, and only if
 * `exists` still finds it there. Restoring straight into the detail view on
 * mount instead would race the credential vault opening (see
 * `vaultReadyRetry.ts`; the detail fetches don't retry) and would leave an
 * error on screen for anything deleted since the last session. Saving is held
 * off until that restore has been resolved, so the initial empty value can't
 * overwrite what's stored before it's been read back.
 */
export function useRestoredSelection<T extends string | null>(
  key: string,
  value: T,
  setValue: (v: T) => void,
  loaded: boolean,
  exists: (v: string) => boolean,
) {
  const pending = useRef<unknown>(readPersisted(key));
  useEffect(() => {
    if (!loaded || pending.current === undefined) return;
    const saved = pending.current;
    pending.current = undefined;
    if (typeof saved === 'string' && saved !== value && exists(saved)) setValue(saved as T);
    // Only re-run when the list first arrives - `exists`/`value` are read as of then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);
  useEffect(() => {
    if (pending.current === undefined) writePersisted(key, value);
  }, [key, value, loaded]);
}
