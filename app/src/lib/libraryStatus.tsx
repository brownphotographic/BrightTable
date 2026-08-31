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

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { getConfig, testConnection, type ConnectionStatus } from './api';
import { retryOnVaultReady } from './vaultReadyRetry';
import { onConfigReloaded } from './configEvents';

// How long a reported local-mount alert stays visible (ConnectionStatusPill
// blinks red) before auto-clearing - long enough to actually notice, short
// enough that it reads as "something just happened" rather than a permanent
// status (unlike `status`/`error` above, which reflect the Immich server
// connection itself and stay however long that connection actually is down).
const LOCAL_MOUNT_ALERT_MS = 8000;

interface LibraryStatusValue {
  status: ConnectionStatus | null;
  error: string | null;
  checking: boolean;
  refresh: () => Promise<void>;
  // Set (briefly) whenever something that depends on the local library mount
  // (Originals on Disk) fails for a reason that looks like a connectivity
  // problem rather than routine "this asset just has no sidecar" - a
  // check_sidecar_metadata timeout being the motivating case (see
  // useAssetActions.ts's scanUnsyncedMetadata). Deliberately separate from
  // `status`/`error` above, which are about the Immich *server* connection,
  // not the local filesystem/NFS mount BrightTable also depends on.
  localMountAlert: string | null;
  reportLocalMountAlert: (message: string) => void;
}

const LibraryStatusContext = createContext<LibraryStatusValue | null>(null);

export function LibraryStatusProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [localMountAlert, setLocalMountAlert] = useState<string | null>(null);

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

  // See `vaultReadyRetry.ts` - the very first `refresh()` above can run
  // before the credential vault has actually opened and see a blank/stale
  // key, which looks like (and is reported as) a real connection failure.
  useEffect(() => retryOnVaultReady(refresh), [refresh]);

  // See `configEvents.ts` - Preferences → Configuration adopting a
  // different settings folder can wholesale-replace `library`'s connection
  // details (URL, API key), which this provider would otherwise have no way
  // to notice until the app restarts.
  useEffect(() => onConfigReloaded(refresh), [refresh]);

  const localMountAlertTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reportLocalMountAlert = useCallback((message: string) => {
    setLocalMountAlert(message);
    if (localMountAlertTimer.current) clearTimeout(localMountAlertTimer.current);
    localMountAlertTimer.current = setTimeout(() => setLocalMountAlert(null), LOCAL_MOUNT_ALERT_MS);
  }, []);
  useEffect(() => () => {
    if (localMountAlertTimer.current) clearTimeout(localMountAlertTimer.current);
  }, []);

  const value = useMemo(
    () => ({ status, error, checking, refresh, localMountAlert, reportLocalMountAlert }),
    [status, error, checking, refresh, localMountAlert, reportLocalMountAlert],
  );

  return <LibraryStatusContext.Provider value={value}>{children}</LibraryStatusContext.Provider>;
}

export function useLibraryStatus() {
  const ctx = useContext(LibraryStatusContext);
  if (!ctx) throw new Error('useLibraryStatus must be used within LibraryStatusProvider');
  return ctx;
}
