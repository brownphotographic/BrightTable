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
import { getConfig, saveThemeMode, type ThemeMode } from './api';

interface ThemeContextValue {
  themeMode: ThemeMode;
  setThemeMode: (next: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

// Same shape as WindowControlsProvider: loads the persisted value once at
// startup, then keeps PreferencesConfiguration (which offers the toggle) in
// sync with every themed surface. Applying `data-theme` to <html> here is
// what actually repaints the app - CSS vars in index.css key off this
// attribute, so no other component needs to read this context to render
// correctly.
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [themeMode, setThemeModeState] = useState<ThemeMode>('dark');

  useEffect(() => {
    getConfig()
      .then((cfg) => {
        setThemeModeState(cfg.themeMode ?? 'dark');
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', themeMode);
  }, [themeMode]);

  const setThemeMode = useCallback((next: ThemeMode) => {
    setThemeModeState(next);
    saveThemeMode(next).catch(() => {});
  }, []);

  return <ThemeContext.Provider value={{ themeMode, setThemeMode }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
}
