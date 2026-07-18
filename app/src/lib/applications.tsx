import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { getConfig, saveApplicationsConfig, type AppChoice, type ApplicationsConfig } from './api';

const DEFAULT_APPLICATIONS: ApplicationsConfig = { rawEditor: null, externalEditor: null, artCliPath: '' };

interface ApplicationsContextValue {
  applications: ApplicationsConfig;
  setEditor: (role: 'rawEditor' | 'externalEditor', choice: AppChoice) => void;
  setArtCliPath: (path: string) => void;
  // Whether the ART CLI round trip is configured - the single signal that
  // switches "Tweak RAW Roundtrip"/adds "Headless RAW Roundtrip" over to the
  // new flow (see the feature plan's decision on this). Derived rather than
  // stored separately so it can never drift from applications.artCliPath.
  artRoundTripEnabled: boolean;
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

  const setArtCliPath = useCallback((path: string) => {
    setApplicationsState((prev) => {
      const next = { ...prev, artCliPath: path };
      saveApplicationsConfig(next).catch(() => {});
      return next;
    });
  }, []);

  const artRoundTripEnabled = applications.artCliPath.trim().length > 0;

  return (
    <ApplicationsContext.Provider value={{ applications, setEditor, setArtCliPath, artRoundTripEnabled }}>
      {children}
    </ApplicationsContext.Provider>
  );
}

export function useApplications(): ApplicationsContextValue {
  const ctx = useContext(ApplicationsContext);
  if (!ctx) throw new Error('useApplications must be used within an ApplicationsProvider');
  return ctx;
}
