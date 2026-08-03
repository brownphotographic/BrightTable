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
