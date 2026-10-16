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
import { getConfig, saveHomeTimeZone } from './api';
import { onConfigReloaded } from './configEvents';
import { isValidZone, systemTimeZone, type ZoneId } from './timeZones';

interface TimeConfigContextValue {
  // As saved - '' means "follow the system".
  homeTimeZoneSetting: string;
  // Resolved - always a usable zone.
  homeTimeZone: ZoneId;
  setHomeTimeZone: (zone: string) => void;
}

const TimeConfigContext = createContext<TimeConfigContextValue | null>(null);

// Preferences → Configuration → Date & Time, shared with the Change Time
// dialog (same shape as GridLoupeSettingsProvider).
export function TimeConfigProvider({ children }: { children: ReactNode }) {
  const [setting, setSetting] = useState('');

  useEffect(() => {
    function load() {
      getConfig()
        .then((cfg) => setSetting(cfg.homeTimeZone ?? ''))
        .catch(() => {});
    }
    load();
    return onConfigReloaded(load);
  }, []);

  const setHomeTimeZone = useCallback((zone: string) => {
    setSetting(zone);
    saveHomeTimeZone(zone).catch(() => {});
  }, []);

  const homeTimeZone = setting && isValidZone(setting) ? setting : systemTimeZone();
  return <TimeConfigContext.Provider value={{ homeTimeZoneSetting: setting, homeTimeZone, setHomeTimeZone }}>{children}</TimeConfigContext.Provider>;
}

export function useTimeConfig(): TimeConfigContextValue {
  const ctx = useContext(TimeConfigContext);
  if (!ctx) throw new Error('useTimeConfig must be used within a TimeConfigProvider');
  return ctx;
}
