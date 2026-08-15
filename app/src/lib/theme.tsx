import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { getConfig, saveThemeMode, saveCanvasShade, type ThemeMode, type CanvasShade } from './api';

interface ThemeContextValue {
  themeMode: ThemeMode;
  setThemeMode: (next: ThemeMode) => void;
  canvasShade: CanvasShade;
  setCanvasShade: (next: CanvasShade) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

// Same shape as WindowControlsProvider: loads the persisted values once at
// startup, then keeps PreferencesConfiguration (which offers the toggles) in
// sync with every themed surface. Applying `data-theme`/`data-canvas-shade`
// to <html> here is what actually repaints the app - CSS vars in index.css
// key off these attributes, so no other component needs to read this
// context to render correctly.
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [themeMode, setThemeModeState] = useState<ThemeMode>('dark');
  const [canvasShade, setCanvasShadeState] = useState<CanvasShade>('default');

  useEffect(() => {
    getConfig()
      .then((cfg) => {
        setThemeModeState(cfg.themeMode ?? 'dark');
        setCanvasShadeState(cfg.canvasShade ?? 'default');
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', themeMode);
  }, [themeMode]);

  useEffect(() => {
    document.documentElement.setAttribute('data-canvas-shade', canvasShade);
  }, [canvasShade]);

  const setThemeMode = useCallback((next: ThemeMode) => {
    setThemeModeState(next);
    saveThemeMode(next).catch(() => {});
  }, []);

  const setCanvasShade = useCallback((next: CanvasShade) => {
    setCanvasShadeState(next);
    saveCanvasShade(next).catch(() => {});
  }, []);

  return (
    <ThemeContext.Provider value={{ themeMode, setThemeMode, canvasShade, setCanvasShade }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
}
