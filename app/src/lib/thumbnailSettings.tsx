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

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { getConfig, saveThumbnailSettings } from './api';
import { onConfigReloaded } from './configEvents';

// Height of the file name caption AssetTile renders under its thumbnail when
// `showFileName` is on - exported so PhotosBrowser's analytic row height
// (which has to know tile heights before they render) can account for it.
export const FILE_NAME_CAPTION_HEIGHT = 20;

interface ThumbnailSettings {
  originalAspect: boolean;
  showFileName: boolean;
}

interface ThumbnailSettingsContextValue extends ThumbnailSettings {
  setOriginalAspect: (next: boolean) => void;
  setShowFileName: (next: boolean) => void;
}

const ThumbnailSettingsContext = createContext<ThumbnailSettingsContextValue | null>(null);

// Same shape as GridLoupeSettingsProvider: loads the persisted values once at
// startup, then keeps every grid (AssetTile/AssetThumbImage) and
// PreferencesConfiguration (which offers the toggles) in sync.
export function ThumbnailSettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<ThumbnailSettings>({ originalAspect: false, showFileName: false });
  // Both values go out in one save command, so each setter needs the other's
  // current value without re-creating itself on every change.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => {
    function load() {
      getConfig()
        .then((cfg) =>
          setSettings({
            originalAspect: cfg.thumbnailOriginalAspect ?? false,
            showFileName: cfg.thumbnailShowFileName ?? false,
          }),
        )
        .catch(() => {});
    }
    load();
    return onConfigReloaded(load);
  }, []);

  const update = useCallback((patch: Partial<ThumbnailSettings>) => {
    const next = { ...settingsRef.current, ...patch };
    settingsRef.current = next;
    setSettings(next);
    saveThumbnailSettings(next.originalAspect, next.showFileName).catch(() => {});
  }, []);

  const setOriginalAspect = useCallback((next: boolean) => update({ originalAspect: next }), [update]);
  const setShowFileName = useCallback((next: boolean) => update({ showFileName: next }), [update]);

  return (
    <ThumbnailSettingsContext.Provider value={{ ...settings, setOriginalAspect, setShowFileName }}>
      {children}
    </ThumbnailSettingsContext.Provider>
  );
}

export function useThumbnailSettings(): ThumbnailSettingsContextValue {
  const ctx = useContext(ThumbnailSettingsContext);
  if (!ctx) throw new Error('useThumbnailSettings must be used within a ThumbnailSettingsProvider');
  return ctx;
}
