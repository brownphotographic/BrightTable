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
import { getConfig, saveWindowControlsPosition, type WindowControlsPosition } from './api';

interface WindowControlsContextValue {
  position: WindowControlsPosition;
  setPosition: (next: WindowControlsPosition) => void;
}

const WindowControlsContext = createContext<WindowControlsContextValue | null>(null);

// Same shape as SmartStackSettingsProvider/useSmartStackSettings: loads the
// persisted value once at startup, then keeps TitleBar (which renders the
// buttons) and PreferencesConfiguration (which offers the toggle) in sync
// with each other even though neither is an ancestor of the other.
export function WindowControlsProvider({ children }: { children: ReactNode }) {
  const [position, setPositionState] = useState<WindowControlsPosition>('right');

  useEffect(() => {
    getConfig()
      .then((cfg) => setPositionState(cfg.windowControlsPosition ?? 'right'))
      .catch(() => {});
  }, []);

  const setPosition = useCallback((next: WindowControlsPosition) => {
    setPositionState(next);
    saveWindowControlsPosition(next).catch(() => {});
  }, []);

  return <WindowControlsContext.Provider value={{ position, setPosition }}>{children}</WindowControlsContext.Provider>;
}

export function useWindowControls(): WindowControlsContextValue {
  const ctx = useContext(WindowControlsContext);
  if (!ctx) throw new Error('useWindowControls must be used within a WindowControlsProvider');
  return ctx;
}
