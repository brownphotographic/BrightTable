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

import { getAsset, regenerateAssetThumbnail } from './api';
import { bumpImageVersion } from './imageVersion';

// Any <img> for an asset whose thumbnail/preview request failed registers the
// asset here (AssetThumbImage, Viewer). One shared loop then polls Immich for
// that asset until it has a thumbHash - Immich sets it in the same job that
// writes the thumbnail/preview files - and bumps the asset's image version so
// every <img> showing it re-requests with a fresh URL.
//
// Found live: freshly imported photos and round-trip exports routinely render
// before Immich has generated their thumbnails, and nothing re-checked them
// afterwards (imports at all; round trips only for ~1 minute, which a batch or
// a busy Immich job queue easily outlasts), so they sat on the ⟳ placeholder
// until the user re-ran the round trip.

// Delay before each successive check of one asset - quick at first (the
// common case is "a few seconds behind"), then backing off.
const CHECK_DELAYS_MS = [2000, 3000, 5000, 5000, 10000, 10000, 15000];
// How long to keep checking an asset that still has no thumbnail.
const GIVE_UP_AFTER_MS = 30 * 60 * 1000;
// Immich doesn't reliably auto-queue thumbnail generation for assets found by
// a library scan (see roundTrip.ts's finishIngest) - nudge it if the thumbnail
// still isn't there after this long, then periodically after that.
const REGENERATE_AFTER_MS = 45 * 1000;
const REGENERATE_EVERY_MS = 3 * 60 * 1000;
// If the asset already has a thumbHash but its image keeps failing anyway
// (e.g. Immich unreachable), stop auto-reloading after this many tries and
// leave it to the tile's manual retry badge.
const MAX_RELOADS = 5;
const TICK_MS = 1000;
// Checks issued per tick, so a whole screen of blank tiles doesn't fire a
// burst of simultaneous requests at Immich.
const MAX_CHECKS_PER_TICK = 6;

interface Watch {
  startedAt: number;
  nextCheckAt: number;
  checks: number;
  lastRegenerateAt: number | null;
  inFlight: boolean;
}

const watches = new Map<string, Watch>();
const reloads = new Map<string, number>();
let timer: ReturnType<typeof setInterval> | null = null;

export function watchMissingThumbnail(assetId: string): void {
  if (!assetId || watches.has(assetId)) return;
  if ((reloads.get(assetId) ?? 0) >= MAX_RELOADS) return;
  const now = Date.now();
  watches.set(assetId, {
    startedAt: now,
    nextCheckAt: now + CHECK_DELAYS_MS[0],
    checks: 0,
    lastRegenerateAt: null,
    inFlight: false,
  });
  if (!timer) timer = setInterval(tick, TICK_MS);
}

// A successful load means whatever was wrong has resolved - forget about it
// so a later failure (e.g. after a rotate) gets the full retry budget again.
export function thumbnailLoaded(assetId: string): void {
  reloads.delete(assetId);
}

function tick(): void {
  const now = Date.now();
  let issued = 0;
  for (const [assetId, w] of watches) {
    if (issued >= MAX_CHECKS_PER_TICK) break;
    if (w.inFlight || now < w.nextCheckAt) continue;
    if (now - w.startedAt > GIVE_UP_AFTER_MS) {
      watches.delete(assetId);
      continue;
    }
    issued++;
    void check(assetId, w);
  }
  if (watches.size === 0 && timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function check(assetId: string, w: Watch): Promise<void> {
  w.inFlight = true;
  const asset = await getAsset(assetId).catch(() => null);
  w.inFlight = false;
  w.checks++;
  const now = Date.now();

  if (asset?.thumbHash) {
    watches.delete(assetId);
    reloads.set(assetId, (reloads.get(assetId) ?? 0) + 1);
    // No thumb_cache eviction needed - failed fetches are never cached
    // (protocol.rs), so a fresh URL is enough to make every <img> re-request.
    bumpImageVersion(assetId);
    return;
  }

  if (
    asset &&
    now - w.startedAt >= REGENERATE_AFTER_MS &&
    (w.lastRegenerateAt == null || now - w.lastRegenerateAt >= REGENERATE_EVERY_MS)
  ) {
    w.lastRegenerateAt = now;
    regenerateAssetThumbnail(assetId).catch(() => {});
  }

  w.nextCheckAt = now + CHECK_DELAYS_MS[Math.min(w.checks, CHECK_DELAYS_MS.length - 1)];
}
