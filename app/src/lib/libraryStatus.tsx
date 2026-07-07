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
