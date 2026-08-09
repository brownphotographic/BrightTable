import { useEditQueue } from '../lib/editQueue';
import { useImportQueue } from '../lib/importQueue';
import { useProcessingQueue } from '../lib/processingQueue';
import { useArtQueue } from '../lib/artQueue';
import { useExportQueue } from '../lib/exportQueue';

// Combines the edit queue, import queue, processing queue, ART queue, and
// export queue's independent, already-tested polls (editQueue.tsx/
// importQueue.tsx untouched; processingQueue.tsx/artQueue.tsx/exportQueue.tsx
// structurally identical) into one TitleBar pill - five simultaneously-
// spinning pills for what's conceptually the same "background job queue"
// idea would be redundant chrome. Mounted in place of the old
// EditQueueIndicator (kept as its own file, just no longer mounted directly).
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

  const pendingCount = editPending + importPending + processingPending + artPending + exportPending;
  const failedCount =
    editJobs.filter((j) => j.status === 'failed').length +
    importJobs.filter((j) => j.status === 'failed').length +
    processingJobs.filter((j) => j.status === 'failed').length +
    artJobs.filter((j) => j.status === 'failed').length +
    exportJobs.filter((j) => j.status === 'failed').length;

  if (pendingCount === 0 && failedCount === 0 && !nudgeError) return null;

  const syncing = pendingCount > 0;
  const failed = !syncing && failedCount > 0;
  const label = syncing ? `${pendingCount} syncing…` : failed ? `${failedCount} failed` : 'Import notice';
  const color = syncing ? '#9cc2f0' : failed ? '#ff8080' : '#ffd699';
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
