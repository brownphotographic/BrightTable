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

import { getCurrentWindow } from '@tauri-apps/api/window';

const appWindow = getCurrentWindow();

// Window is `decorations: false` (see tauri.conf.json) - there's no native
// OS border to grab, so without this the only way to resize is whatever
// razor-thin edge a Linux window manager happens to hit-test around an
// undecorated window (varies by WM, and on several is effectively nothing).
// These are plain invisible drag strips along each edge/corner that call
// Tauri's own `startResizeDragging`.
//
// No bottom-right (SouthEast) handle: that corner is where the Photos/
// Folders/Trash status bars put their own right-aligned controls (thumbnail
// zoom slider, "Empty Trash"), and it was stealing clicks from them.
//
// EDGE must span the full `--window-frame-margin` (index.css) - that margin
// is the transparent gap between the true (unmaximized) window edge, where
// these handles are anchored, and .window-frame's own visible/shadowed
// border. A thinner strip leaves a dead zone between where the handle stops
// and where the user actually sees (and hovers over) the window's edge.
const EDGE = 16;
const CORNER = 24;

type Dir = 'North' | 'South' | 'East' | 'West' | 'NorthEast' | 'NorthWest' | 'SouthEast' | 'SouthWest';

function startDrag(dir: Dir) {
  return (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    appWindow.startResizeDragging(dir).catch(() => {});
  };
}

function edgeStyle(extra: React.CSSProperties): React.CSSProperties {
  return { position: 'fixed', zIndex: 1000, ...extra };
}

export default function ResizeHandles() {
  return (
    <>
      <div onMouseDown={startDrag('North')} style={edgeStyle({ top: 0, left: CORNER, right: CORNER, height: EDGE, cursor: 'ns-resize' })} />
      <div onMouseDown={startDrag('South')} style={edgeStyle({ bottom: 0, left: CORNER, right: CORNER, height: EDGE, cursor: 'ns-resize' })} />
      <div onMouseDown={startDrag('West')} style={edgeStyle({ left: 0, top: CORNER, bottom: CORNER, width: EDGE, cursor: 'ew-resize' })} />
      <div onMouseDown={startDrag('East')} style={edgeStyle({ right: 0, top: CORNER, bottom: CORNER, width: EDGE, cursor: 'ew-resize' })} />

      <div onMouseDown={startDrag('NorthWest')} style={edgeStyle({ top: 0, left: 0, width: CORNER, height: CORNER, cursor: 'nwse-resize' })} />
      <div onMouseDown={startDrag('NorthEast')} style={edgeStyle({ top: 0, right: 0, width: CORNER, height: CORNER, cursor: 'nesw-resize' })} />
      <div onMouseDown={startDrag('SouthWest')} style={edgeStyle({ bottom: 0, left: 0, width: CORNER, height: CORNER, cursor: 'nesw-resize' })} />
    </>
  );
}
