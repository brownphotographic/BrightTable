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

import { useEditQueue } from '../lib/editQueue';

// Mounted in TitleBar (visible across every left-nav tab, unlike Sidebar's
// page-scoped static readouts). Renders nothing while idle; otherwise a
// small pill showing either the live in-flight count or, once everything's
// settled but some failed, an unacknowledged-failure count. Clicking it
// opens the shared ActivityPanel.
export default function EditQueueIndicator({ onClick }: { onClick: () => void }) {
  const { jobs, pendingCount } = useEditQueue();
  const failedCount = jobs.filter((j) => j.status === 'failed').length;

  if (pendingCount === 0 && failedCount === 0) return null;

  const syncing = pendingCount > 0;
  const label = syncing ? `${pendingCount} syncing…` : `${failedCount} failed`;

  return (
    <div
      onClick={onClick}
      title="Recent Activity"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        height: 24,
        padding: '0 10px',
        borderRadius: 12,
        fontSize: 11.5,
        fontWeight: 700,
        cursor: 'default',
        color: syncing ? 'var(--accent-text)' : '#ff8080',
        background: syncing ? 'rgba(53,132,228,0.22)' : 'rgba(224,27,36,0.22)',
      }}
    >
      {syncing && (
        <div
          style={{
            width: 9,
            height: 9,
            flexShrink: 0,
            borderRadius: '50%',
            border: '1.5px solid currentColor',
            borderTopColor: 'transparent',
            animation: 'brighttable-spin 0.8s linear infinite',
          }}
        />
      )}
      {label}
    </div>
  );
}
