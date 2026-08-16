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

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { getConfig, testConnection, type ConnectionStatus } from './api';

interface LibraryStatusValue {
  status: ConnectionStatus | null;
  error: string | null;
  checking: boolean;
  refresh: () => Promise<void>;
}

const LibraryStatusContext = createContext<LibraryStatusValue | null>(null);

export function LibraryStatusProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const refresh = useCallback(async () => {
    setChecking(true);
    try {
      const cfg = await getConfig();
      const res = await testConnection(cfg.library);
      setStatus(res);
      setError(null);
    } catch (e) {
      setStatus(null);
      setError(String(e));
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const value = useMemo(() => ({ status, error, checking, refresh }), [status, error, checking, refresh]);

  return <LibraryStatusContext.Provider value={value}>{children}</LibraryStatusContext.Provider>;
}

export function useLibraryStatus() {
  const ctx = useContext(LibraryStatusContext);
  if (!ctx) throw new Error('useLibraryStatus must be used within LibraryStatusProvider');
  return ctx;
}
