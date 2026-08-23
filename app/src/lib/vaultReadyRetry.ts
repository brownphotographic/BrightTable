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

import { listen } from '@tauri-apps/api/event';

const RETRY_DELAYS_MS = [500, 1200, 2500, 4500];

/**
 * The credential vault (Immich API key) opens on a background thread rather
 * than blocking startup (see `lib.rs`'s `.setup()`), and signals it's ready
 * via a one-shot `vault-ready` event once it's populated `AppState`'s
 * config - so anything that fetched from the library before then can fail
 * with "No API key configured" and needs to retry once it's actually ready.
 *
 * A plain `listen('vault-ready', reload)` isn't enough on its own though:
 * Tauri events are fire-and-forget with no replay, and the backend's ~1s
 * Stronghold decrypt can finish (and emit) before this component has even
 * mounted far enough to register the listener - a cold dev-mode Vite load
 * is easily slow enough to lose that race, in which case the event is gone
 * forever and nothing else ever retries, leaving the very first failed
 * fetch's error on screen permanently. Retrying `reload` on a short bounded
 * backoff regardless of the event closes that gap - `reload` firing again
 * after it already succeeded is harmless, since these are cheap, idempotent
 * read-only fetches.
 */
export function retryOnVaultReady(reload: () => void): () => void {
  let cancelled = false;
  const timers = RETRY_DELAYS_MS.map((delay) =>
    setTimeout(() => {
      if (!cancelled) reload();
    }, delay),
  );
  const unlistenPromise = listen('vault-ready', () => reload());
  return () => {
    cancelled = true;
    timers.forEach(clearTimeout);
    unlistenPromise.then((fn) => fn());
  };
}
