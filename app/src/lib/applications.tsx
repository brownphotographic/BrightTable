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
import { getConfig, saveApplicationsConfig, type AppChoice, type ApplicationsConfig, type RawConverterKind } from './api';

const DEFAULT_APPLICATIONS: ApplicationsConfig = {
  externalEditor: null,
  activeRawConverter: null,
  art: { app: null, cliPath: '' },
  rawtherapee: { app: null, cliPath: '' },
  darktable: { app: null, cliPath: '' },
  exiftoolPath: '',
};

interface ApplicationsContextValue {
  applications: ApplicationsConfig;
  setExternalEditor: (choice: AppChoice) => void;
  // Sets one converter's GUI app - each tool owns its own app *and* CLI path
  // together (see ApplicationsConfig's own doc comment for why), so unlike
  // the old shared `rawEditor` field this always targets a specific tool.
  setToolApp: (tool: RawConverterKind, choice: AppChoice) => void;
  setToolCliPath: (tool: RawConverterKind, path: string) => void;
  setActiveRawConverter: (tool: RawConverterKind | null) => void;
  setExiftoolPath: (path: string) => void;
  // The GUI app that "Open in RAW Editor"/"Tweak RAW Roundtrip" launches -
  // the active converter's own `app`, or null if no converter is active
  // (redirects to Preferences the same way an unset externalEditor does).
  // Derived rather than read as a flat field, since which tool's `app`
  // applies depends on `activeRawConverter`.
  activeRawEditorApp: AppChoice | null;
  // Whether the RAW CLI round trip is configured and actually usable - the
  // single signal that switches "Tweak RAW Roundtrip"/adds "Headless RAW
  // Roundtrip" over to the CLI-driven flow (see the feature plan's decision
  // on this). True whenever activeRawConverter is set to any of the three
  // converters and that tool's own cliPath is non-empty. Derived rather than
  // stored separately so it can never drift from the underlying config.
  rawRoundTripEnabled: boolean;
  // Whether exiftool is configured - required by the export dialogs' "Keep
  // all metadata"/"Remove GPS only" options. Derived, same idiom as
  // rawRoundTripEnabled.
  exiftoolConfigured: boolean;
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

  const setExternalEditor = useCallback((choice: AppChoice) => {
    setApplicationsState((prev) => {
      const next = { ...prev, externalEditor: choice };
      saveApplicationsConfig(next).catch(() => {});
      return next;
    });
  }, []);

  const setToolApp = useCallback((tool: RawConverterKind, choice: AppChoice) => {
    setApplicationsState((prev) => {
      const next = { ...prev, [tool]: { ...prev[tool], app: choice } };
      saveApplicationsConfig(next).catch(() => {});
      return next;
    });
  }, []);

  const setToolCliPath = useCallback((tool: RawConverterKind, path: string) => {
    setApplicationsState((prev) => {
      const next = { ...prev, [tool]: { ...prev[tool], cliPath: path } };
      saveApplicationsConfig(next).catch(() => {});
      return next;
    });
  }, []);

  const setActiveRawConverter = useCallback((tool: RawConverterKind | null) => {
    setApplicationsState((prev) => {
      const next = { ...prev, activeRawConverter: tool };
      saveApplicationsConfig(next).catch(() => {});
      return next;
    });
  }, []);

  const setExiftoolPath = useCallback((path: string) => {
    setApplicationsState((prev) => {
      const next = { ...prev, exiftoolPath: path };
      saveApplicationsConfig(next).catch(() => {});
      return next;
    });
  }, []);

  const activeTool = applications.activeRawConverter ? applications[applications.activeRawConverter] : null;
  const activeRawEditorApp = activeTool?.app ?? null;
  const rawRoundTripEnabled =
    (applications.activeRawConverter === 'art' || applications.activeRawConverter === 'rawtherapee' || applications.activeRawConverter === 'darktable') &&
    (activeTool?.cliPath.trim().length ?? 0) > 0;
  const exiftoolConfigured = applications.exiftoolPath.trim().length > 0;

  return (
    <ApplicationsContext.Provider
      value={{
        applications,
        setExternalEditor,
        setToolApp,
        setToolCliPath,
        setActiveRawConverter,
        setExiftoolPath,
        activeRawEditorApp,
        rawRoundTripEnabled,
        exiftoolConfigured,
      }}
    >
      {children}
    </ApplicationsContext.Provider>
  );
}

export function useApplications(): ApplicationsContextValue {
  const ctx = useContext(ApplicationsContext);
  if (!ctx) throw new Error('useApplications must be used within an ApplicationsProvider');
  return ctx;
}
