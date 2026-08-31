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

import type { AssetSummary } from './api';

// Mirrors the design prototype's visibleAssets()/isHiddenChild(): every
// non-pick member of a stack is hidden from the flat grid, selection,
// keyboard nav, and the Viewer's prev/next - only one row per stack ever
// shows up. Expanding a stack inline is the only way to see its other
// members (StackBand fetches them separately).
//
// The one row a stack shows through is pinned to whichever member is
// FIRST in the caller's existing array order - not whichever member is
// currently the pick. Every page that calls this feeds it an array in a
// fixed, pick-independent order (fileCreatedAt-desc for the bucketed grids,
// whatever order the server returned for Albums/People/Tags/Search), so
// "first occurrence" is a stable anchor across pick changes. Without this,
// re-picking a stack member swaps which array slot passes the filter, and
// since each member sits at its own position in that order, the stack's
// row visibly jumps there instead of staying put - the array slot shown is
// still filled with the current pick's own data (thumbnail, filename,
// rating, etc.), just anchored at the stable slot's position.
export function resolveVisibleStackAssets<T extends AssetSummary>(assets: T[]): T[] {
  const anchorIndexByStack = new Map<string, number>();
  const pickByStack = new Map<string, T>();
  assets.forEach((a, i) => {
    if (!a.stack) return;
    if (!anchorIndexByStack.has(a.stack.id)) anchorIndexByStack.set(a.stack.id, i);
    if (a.stack.primaryAssetId === a.id) pickByStack.set(a.stack.id, a);
  });
  const out: T[] = [];
  assets.forEach((a, i) => {
    if (!a.stack) {
      out.push(a);
      return;
    }
    if (anchorIndexByStack.get(a.stack.id) !== i) return;
    const pick = pickByStack.get(a.stack.id);
    // No pick found at this anchor's position means the pick isn't loaded
    // into this same array (e.g. it lives in a bucket/page that hasn't
    // fetched yet) - fall back to showing the anchor itself rather than
    // hiding the stack entirely.
    out.push(!pick || pick === a ? a : ({ ...pick, fileCreatedAt: a.fileCreatedAt } as T));
  });
  return out;
}
