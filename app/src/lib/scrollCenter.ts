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

// Scrolls `container` so the tile carrying `data-asset-id={assetId}` (see
// AssetTile.tsx) sits vertically centered - used to keep the same photo
// under the loupe as the grid narrows/widens when grid loupe mode toggles,
// instead of the wildly different-looking scroll position a column-count
// change would otherwise leave behind. Delegates the actual coordinate math
// to the browser's own scrollIntoView rather than computing scrollTop by
// hand - does nothing if the tile isn't currently mounted (its row was
// virtualized out).
function centerAssetInContainer(container: HTMLElement, assetId: string): void {
  const el = container.querySelector<HTMLElement>(`[data-asset-id="${CSS.escape(assetId)}"]`);
  el?.scrollIntoView({ block: 'center', inline: 'nearest' });
}

// Waits two animation frames before centering - the container's own resize
// (loupeOn toggling its flex-basis) needs a layout pass to take its new
// size, and this page's column-count recompute (a React state update queued
// off a ResizeObserver reading that new size) needs a further render +
// layout pass on top of that, so acting immediately or after only one frame
// can still land mid-transition and center against a stale, about-to-change
// layout.
export function centerAssetInContainerSoon(container: HTMLElement, assetId: string): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      centerAssetInContainer(container, assetId);
    });
  });
}
