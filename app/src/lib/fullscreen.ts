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

import { useEffect, useSyncExternalStore } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';

// Image fullscreen: the window goes OS-fullscreen and the open Viewer drops
// all of its chrome (header, info panel, filmstrip, prev/next arrows) to
// show just the photo on black. Kept as a tiny module-level store so App's
// Ctrl+F/Esc handlers, the View menu and the Viewer's own More… dropdown can
// all read/toggle it without threading a prop through every browser page
// that mounts <Viewer>.
let imageFullscreen = false;
let lastToggleAt = 0;
const listeners = new Set<() => void>();

function setState(next: boolean) {
  if (next === imageFullscreen) return;
  imageFullscreen = next;
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function isImageFullscreen(): boolean {
  return imageFullscreen;
}

export function useImageFullscreen(): boolean {
  return useSyncExternalStore(subscribe, isImageFullscreen);
}

// State flips synchronously (before the async window call) so a Viewer
// mounted in the same tick - App opening the grid's last-clicked photo
// straight into fullscreen - already sees `true` on its first render.
export function setImageFullscreen(next: boolean): void {
  if (next === imageFullscreen) return;
  setState(next);
  lastToggleAt = Date.now();
  getCurrentWindow()
    .setFullscreen(next)
    .catch(() => setState(!next));
}

// Number of mounted Viewers. When the last one unmounts while fullscreen
// (closed via its own Back/Delete, a tab switch, ...) there's no photo left
// to show, so fullscreen ends with it. Checked on a timeout rather than
// directly in the unmount cleanup so StrictMode's dev-only unmount/remount
// doesn't kick straight back out.
let mountedViewers = 0;

export function useViewerFullscreenLifecycle(): void {
  useEffect(() => {
    mountedViewers++;
    return () => {
      mountedViewers--;
      setTimeout(() => {
        if (mountedViewers === 0) setImageFullscreen(false);
      });
    };
  }, []);
}

// Called once, at the app root. Tauri has no fullscreen-changed event, so
// this re-reads isFullscreen() on every resize - if the WM/compositor takes
// the window out of fullscreen itself, image fullscreen ends too. Resizes
// within a second of our own toggle are ignored - some WMs fire one before
// isFullscreen() reports the new state.
export function useSyncImageFullscreen(): void {
  useEffect(() => {
    const win = getCurrentWindow();
    const unlisten = win.onResized(() => {
      if (!imageFullscreen || Date.now() - lastToggleAt < 1000) return;
      win
        .isFullscreen()
        .then((fs) => {
          if (!fs) setState(false);
        })
        .catch(() => {});
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);
}
