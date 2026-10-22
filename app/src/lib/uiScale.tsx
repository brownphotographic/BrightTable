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

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getConfig, saveUiScale } from './api';
import { onConfigReloaded } from './configEvents';

// The fixed steps Preferences offers and View → Larger/Smaller Interface
// walks through. Every size in the UI is a hard-coded px value, so rather
// than scaling fonts and icons separately (which would drift apart from the
// paddings/row heights around them), the whole webview is zoomed - text,
// icons, spacing and borders all grow together.
export const UI_SCALES = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const;

function clampScale(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 1;
  return Math.min(UI_SCALES[UI_SCALES.length - 1], Math.max(UI_SCALES[0], v));
}

export function nextUiScale(cur: number, dir: 1 | -1): number {
  if (dir > 0) return UI_SCALES.find((s) => s > cur + 0.001) ?? cur;
  return [...UI_SCALES].reverse().find((s) => s < cur - 0.001) ?? cur;
}

// Module-level mirror of the applied zoom, so code that needs real device
// pixels (Viewer's hi-res swap, the grid's thumbnail rendition pick) can ask
// effectiveDpr() without threading the context through.
let appliedScale = 1;
// Whether this engine already folds page zoom into window.devicePixelRatio
// (Chromium does; WebKit doesn't) - measured the first time a non-100% zoom
// is applied, until then assume it doesn't.
let dprIncludesZoom = false;
let dprProbed = false;

// CSS px → device px for the current screen *and* interface zoom.
export function effectiveDpr(): number {
  const dpr = window.devicePixelRatio || 1;
  return dprIncludesZoom ? dpr : dpr * appliedScale;
}

async function applyZoom(scale: number) {
  const before = window.devicePixelRatio || 1;
  const prev = appliedScale;
  try {
    await getCurrentWebview().setZoom(scale);
  } catch {
    return;
  }
  appliedScale = scale;
  if (!dprProbed && Math.abs(scale - prev) > 0.001) {
    // Give the engine a frame to settle before comparing.
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const after = window.devicePixelRatio || 1;
    dprIncludesZoom = Math.abs(after / before - scale / prev) < 0.02;
    dprProbed = true;
  }
}

interface UiScaleContextValue {
  uiScale: number;
  setUiScale: (next: number) => void;
}

const UiScaleContext = createContext<UiScaleContextValue | null>(null);

// Same shape as ThemeProvider: loads the persisted value once at startup,
// then keeps Preferences, the View menu and the shortcuts in sync.
export function UiScaleProvider({ children }: { children: ReactNode }) {
  const [uiScale, setUiScaleState] = useState(1);

  useEffect(() => {
    function load() {
      getConfig()
        .then((cfg) => setUiScaleState(clampScale(cfg.uiScale ?? 1)))
        .catch(() => {});
    }
    load();
    return onConfigReloaded(load);
  }, []);

  useEffect(() => {
    applyZoom(uiScale);
  }, [uiScale]);

  const setUiScale = useCallback((next: number) => {
    const clamped = clampScale(next);
    setUiScaleState(clamped);
    saveUiScale(clamped).catch(() => {});
  }, []);

  return <UiScaleContext.Provider value={{ uiScale, setUiScale }}>{children}</UiScaleContext.Provider>;
}

export function useUiScale(): UiScaleContextValue {
  const ctx = useContext(UiScaleContext);
  if (!ctx) throw new Error('useUiScale must be used within a UiScaleProvider');
  return ctx;
}
