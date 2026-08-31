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

import { useEffect, useRef, useState } from 'react';
import { useLibraryStatus } from '../lib/libraryStatus';
import ResourceChart from './ResourceChart';

// The connection readout and (dev-only) resource chart used to live in the
// old Sidebar's footer, visible only while that tab's pane happened to be
// mounted alongside it. Moved here so it's visible from every tab, same as
// ActivityIndicator right next to it.
export default function ConnectionStatusPill({ onOpenLibrarySettings }: { onOpenLibrarySettings: () => void }) {
  const { status, checking, error, localMountAlert } = useLibraryStatus();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const versionWarning = !!status && !status.serverVersionSupported;
  // Immich API reachable (`status` truthy) says nothing about whether the
  // local External Library / uploaded-storage mount backing local file
  // operations is actually up - confirmed live: an NFS-mounted library
  // dropped out while Immich itself stayed reachable, and this pill kept
  // showing green with zero indication anything was wrong. `localMountOk`
  // is `null` when no local mapping is configured at all, which must not
  // read as broken.
  const localMountDown = !!status && status.localMountOk === false;
  const dotColor = checking
    ? 'var(--text-dimmer)'
    : status
      ? localMountDown
        ? 'var(--danger)'
        : versionWarning
          ? 'var(--warn)'
          : 'var(--ok)'
      : error
        ? 'var(--danger)'
        : 'var(--text-dimmer)';
  const statusText = checking
    ? 'Connecting…'
    : status
      ? `Connected · ${status.via}${localMountDown ? ' · local mount unreachable' : versionWarning ? ' · old server version' : ''}`
      : 'Not connected';

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <div
        onClick={() => setOpen((v) => !v)}
        title={localMountAlert ?? status?.localMountError ?? undefined}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          height: 24,
          padding: '0 10px',
          borderRadius: 7,
          background: open ? 'var(--overlay-strong)' : 'var(--overlay-medium)',
          fontSize: 11.5,
          color: 'var(--text-dim)',
          cursor: 'default',
        }}
      >
        <div
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            flexShrink: 0,
            background: localMountAlert ? 'var(--danger)' : dotColor,
            animation: localMountAlert ? 'brighttable-blink 0.6s ease-in-out 5' : undefined,
          }}
        />
        <span style={{ whiteSpace: 'nowrap' }}>{statusText}</span>
      </div>

      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            width: 252,
            background: 'var(--panel)',
            border: '1px solid var(--border)',
            borderRadius: 12,
            boxShadow: '0 12px 34px rgba(0,0,0,0.6)',
            padding: 13,
            zIndex: 80,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: dotColor }} />
            <span style={{ fontSize: 12.5, fontWeight: 700 }}>{statusText}</span>
          </div>
          {status?.resolvedUrl && (
            <div
              style={{
                marginTop: 6,
                fontSize: 11.5,
                fontFamily: 'monospace',
                color: 'var(--text-dimmer)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {status.resolvedUrl}
            </div>
          )}
          {error && (
            <div style={{ marginTop: 6, fontSize: 11.5, color: 'var(--danger)' }}>{error}</div>
          )}
          {status?.localMountError && (
            <div style={{ marginTop: 6, fontSize: 11.5, color: 'var(--danger)' }}>{status.localMountError}</div>
          )}
          {localMountAlert && (
            <div style={{ marginTop: 6, fontSize: 11.5, color: 'var(--danger)' }}>{localMountAlert}</div>
          )}

          {import.meta.env.DEV && (
            <div style={{ margin: '10px -13px 0', borderTop: '1px solid var(--border)' }}>
              <ResourceChart />
            </div>
          )}

          <div
            onClick={() => {
              setOpen(false);
              onOpenLibrarySettings();
            }}
            style={{
              marginTop: 10,
              height: 30,
              display: 'flex',
              alignItems: 'center',
              paddingLeft: 10,
              borderRadius: 8,
              background: 'var(--overlay-weak)',
              fontSize: 12.5,
              cursor: 'default',
            }}
          >
            Library Settings…
          </div>
        </div>
      )}
    </div>
  );
}
