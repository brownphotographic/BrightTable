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

import { useEffect } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';

// Called once, at the app root (see App.tsx) - keeps <html data-window-
// maximized> in sync with Tauri's real window state, which every window/
// overlay's CSS (the .window-frame/.window-frame-overlay/.window-frame-
// margin rules in index.css) reads off `:root[data-window-maximized]`
// rather than each polling isMaximized() itself. Native GTK windows flatten
// to 0 margin/radius/no shadow while maximized or tiled - this is what
// mirrors that. Polls on every resize since Tauri has no dedicated
// maximize-changed event.
export function useSyncWindowFrameMaximized(): void {
  useEffect(() => {
    const win = getCurrentWindow();
    const sync = () => {
      win
        .isMaximized()
        .then((maximized) => {
          document.documentElement.dataset.windowMaximized = String(maximized);
        })
        .catch(() => {});
    };
    sync();
    const unlisten = win.onResized(sync);
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);
}
