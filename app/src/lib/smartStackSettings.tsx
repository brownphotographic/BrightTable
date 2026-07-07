import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { getConfig, saveSmartStackSettings, type SmartStackSettings } from './api';

const DEFAULT_SETTINGS: SmartStackSettings = { mode: 'name', suffix: '*converted*', tolerance: 10 };

interface SmartStackSettingsContextValue {
  settings: SmartStackSettings;
  setSettings: (next: SmartStackSettings) => void;
}

const SmartStackSettingsContext = createContext<SmartStackSettingsContextValue | null>(null);

// Mirrors ShortcutsProvider/useShortcuts (lib/shortcuts.tsx) exactly - the
// Smart Stack dialog's mode/suffix/tolerance persist across restarts the same
// way rebound keyboard shortcuts do, so the user's real ART/RawTherapee
// suffix (e.g. " - converted") only needs typing once.
export function SmartStackSettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettingsState] = useState<SmartStackSettings>(DEFAULT_SETTINGS);

  useEffect(() => {
    getConfig()
      .then((cfg) => setSettingsState({ ...DEFAULT_SETTINGS, ...cfg.smartStack }))
      .catch(() => {});
  }, []);

  const setSettings = useCallback((next: SmartStackSettings) => {
    setSettingsState(next);
    saveSmartStackSettings(next).catch(() => {});
  }, []);

  return (
    <SmartStackSettingsContext.Provider value={{ settings, setSettings }}>
      {children}
    </SmartStackSettingsContext.Provider>
  );
}

export function useSmartStackSettings(): SmartStackSettingsContextValue {
  const ctx = useContext(SmartStackSettingsContext);
  if (!ctx) throw new Error('useSmartStackSettings must be used within a SmartStackSettingsProvider');
  return ctx;
}
