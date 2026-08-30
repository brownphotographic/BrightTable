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
import { useImportQueue } from '../lib/importQueue';
import { useProcessingQueue } from '../lib/processingQueue';
import { useArtQueue } from '../lib/artQueue';
import { useExportQueue } from '../lib/exportQueue';
import { useStackQueue } from '../lib/stackQueue';

// Combines the edit queue, import queue, processing queue, ART queue,
// export queue, and stack queue's independent, already-tested polls
// (editQueue.tsx/importQueue.tsx untouched; processingQueue.tsx/
// artQueue.tsx/exportQueue.tsx/stackQueue.tsx structurally identical) into
// one TitleBar pill - six simultaneously-spinning pills for what's
// conceptually the same "background job queue" idea would be redundant
// chrome. Mounted in place of the old EditQueueIndicator (kept as its own
// file, just no longer mounted directly).
//
// Labeled generically ("in progress", not "syncing") since not every one of
// these is really a server sync - the stack queue and ART/processing queues
// are just as much "local background work" as they are server writes, and
// this pill is the one place a user checks for any of them.
//
// exportQueue was left out of this originally, so a folder/Flickr export
// that failed after being enqueued (the dialog closes as soon as jobs are
// queued, not once they finish) produced literally no visible signal
// anywhere unless the user happened to have the Activity panel open already.
export default function ActivityIndicator({ onClick }: { onClick: () => void }) {
  const { jobs: editJobs, pendingCount: editPending } = useEditQueue();
  const { jobs: importJobs, pendingCount: importPending, nudgeError } = useImportQueue();
  const { jobs: processingJobs, pendingCount: processingPending } = useProcessingQueue();
  const { jobs: artJobs, pendingCount: artPending } = useArtQueue();
  const { jobs: exportJobs, pendingCount: exportPending } = useExportQueue();
  const { jobs: stackJobs, pendingCount: stackPending } = useStackQueue();

  const pendingCount = editPending + importPending + processingPending + artPending + exportPending + stackPending;
  const failedCount =
    editJobs.filter((j) => j.status === 'failed').length +
    importJobs.filter((j) => j.status === 'failed').length +
    processingJobs.filter((j) => j.status === 'failed').length +
    artJobs.filter((j) => j.status === 'failed').length +
    exportJobs.filter((j) => j.status === 'failed').length +
    stackJobs.filter((j) => j.status === 'failed').length;

  if (pendingCount === 0 && failedCount === 0 && !nudgeError) return null;

  const syncing = pendingCount > 0;
  const failed = !syncing && failedCount > 0;
  const label = syncing ? `${pendingCount} in progress…` : failed ? `${failedCount} failed` : 'Import notice';
  const color = syncing ? 'var(--accent-text)' : failed ? '#ff8080' : 'var(--warn)';
  const bg = syncing ? 'rgba(53,132,228,0.22)' : failed ? 'rgba(224,27,36,0.22)' : 'rgba(229,165,10,0.22)';

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
        color,
        background: bg,
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
