import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { getConfig, saveApplicationsConfig, type AppChoice, type ApplicationsConfig } from './api';

const DEFAULT_APPLICATIONS: ApplicationsConfig = { rawEditor: null, externalEditor: null };

interface ApplicationsContextValue {
  applications: ApplicationsConfig;
  setEditor: (role: 'rawEditor' | 'externalEditor', choice: AppChoice) => void;
}

const ApplicationsContext = createContext<ApplicationsContextValue | null>(null);

// Mirrors SmartStackSettingsProvider (lib/smartStackSettings.tsx) exactly -
// the chosen RAW/external editor persists across restarts the same way, so
// Viewer.tsx's editor buttons and PreferencesApplications both read from one
// shared, already-loaded value instead of each doing their own getConfig().
export function ApplicationsProvider({ children }: { children: ReactNode }) {
  const [applications, setApplicationsState] = useState<ApplicationsConfig>(DEFAULT_APPLICATIONS);

  useEffect(() => {
    getConfig()
      .then((cfg) => setApplicationsState({ ...DEFAULT_APPLICATIONS, ...cfg.applications }))
      .catch(() => {});
  }, []);

  const setEditor = useCallback((role: 'rawEditor' | 'externalEditor', choice: AppChoice) => {
    setApplicationsState((prev) => {
      const next = { ...prev, [role]: choice };
      saveApplicationsConfig(next).catch(() => {});
      return next;
    });
  }, []);

  return <ApplicationsContext.Provider value={{ applications, setEditor }}>{children}</ApplicationsContext.Provider>;
}

export function useApplications(): ApplicationsContextValue {
  const ctx = useContext(ApplicationsContext);
  if (!ctx) throw new Error('useApplications must be used within an ApplicationsProvider');
  return ctx;
}
