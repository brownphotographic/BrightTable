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
