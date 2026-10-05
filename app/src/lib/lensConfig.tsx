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
import { getConfig, saveLensConfig, type LensConfig } from './api';
import { onConfigReloaded } from './configEvents';

export const DEFAULT_LENS_CONFIG: LensConfig = {
  writeOriginals: false,
  keepOriginalBackup: true,
  updateRawProfiles: true,
  notePrefix: 'Lens: ',
  customLenses: [],
  mappings: [],
};

interface LensConfigContextValue {
  lensConfig: LensConfig;
  // Resolves once persisted; rejects (and leaves the in-memory value
  // reverted) on a failed save, so callers can surface it - unlike the
  // fire-and-forget saves elsewhere, a silently lost lens list would be
  // tedious to retype.
  saveLensConfig: (next: LensConfig) => Promise<void>;
}

const LensConfigContext = createContext<LensConfigContextValue | null>(null);

// Preferences → Lenses, shared with the Change Lens dialog (which adds
// custom lenses inline) so both always see the same list.
export function LensConfigProvider({ children }: { children: ReactNode }) {
  const [lensConfig, setLensConfig] = useState<LensConfig>(DEFAULT_LENS_CONFIG);

  useEffect(() => {
    function load() {
      getConfig()
        .then((cfg) => setLensConfig({ ...DEFAULT_LENS_CONFIG, ...cfg.lens }))
        .catch(() => {});
    }
    load();
    return onConfigReloaded(load);
  }, []);

  const save = useCallback(
    async (next: LensConfig) => {
      const prev = lensConfig;
      setLensConfig(next);
      try {
        await saveLensConfig(next);
      } catch (e) {
        setLensConfig(prev);
        throw e;
      }
    },
    [lensConfig],
  );

  return <LensConfigContext.Provider value={{ lensConfig, saveLensConfig: save }}>{children}</LensConfigContext.Provider>;
}

export function useLensConfig(): LensConfigContextValue {
  const ctx = useContext(LensConfigContext);
  if (!ctx) throw new Error('useLensConfig must be used within a LensConfigProvider');
  return ctx;
}
