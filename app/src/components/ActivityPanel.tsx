import { useEditQueue } from '../lib/editQueue';
import { useImportQueue } from '../lib/importQueue';
import { thumbnailSrc, type EditJob, type ImportJob, type ImportJobStatus } from '../lib/api';

function kindLabel(job: EditJob): string {
  const parts: string[] = [];
  if (job.rating !== null) parts.push(job.rating === -1 ? 'Reject' : `${job.rating}★`);
  if (job.isFavorite !== null) parts.push(job.isFavorite ? 'Favorite' : 'Unfavorite');
  if (job.description !== null) parts.push('Caption');
  return parts.join(' · ') || 'Edit';
}

function statusPill(status: EditJob['status']): { label: string; color: string; bg: string } {
  switch (status) {
    case 'pending':
      return { label: 'Queued', color: 'rgba(255,255,255,0.6)', bg: 'rgba(255,255,255,0.08)' };
    case 'writing':
      return { label: 'Syncing…', color: '#9cc2f0', bg: 'rgba(53,132,228,0.22)' };
    case 'done':
      return { label: 'Done', color: '#8ce0ae', bg: 'rgba(46,194,126,0.18)' };
    case 'failed':
      return { label: 'Failed', color: '#ff8080', bg: 'rgba(224,27,36,0.2)' };
  }
}

function importStatusPill(status: ImportJobStatus): { label: string; color: string; bg: string } {
  switch (status) {
    case 'pending':
      return { label: 'Queued', color: 'rgba(255,255,255,0.6)', bg: 'rgba(255,255,255,0.08)' };
    case 'copying':
      return { label: 'Copying…', color: '#9cc2f0', bg: 'rgba(53,132,228,0.22)' };
    case 'done':
      return { label: 'Done', color: '#8ce0ae', bg: 'rgba(46,194,126,0.18)' };
    case 'failed':
      return { label: 'Failed', color: '#ff8080', bg: 'rgba(224,27,36,0.2)' };
  }
}

function baseName(path: string): string {
  return path.split('/').pop() ?? path;
}

function formatMB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

// Modal, reusing ConfirmDialog's overlay/card conventions rather than
// docking like MetadataPanel - this is a cross-cutting, occasional concern,
// not tied to "what's selected". Two sections (Edits / Imports) reading from
// two independent, already-tested queues/providers (editQueue.tsx unchanged;
// importQueue.tsx is the new, structurally identical sibling) - kept as two
// separate polls/contexts rather than unifying into one generic queue type,
// since this merge is UI-only. Visual language loosely modeled on Immich
// Desktop's own "Recent Activity" modal, not copied verbatim.
export default function ActivityPanel({ onClose }: { onClose: () => void }) {
  const { jobs: editJobs, clearCompleted: clearEditCompleted } = useEditQueue();
  const { jobs: importJobs, clearCompleted: clearImportCompleted, nudgeError } = useImportQueue();
  const sortedEdits = [...editJobs].sort((a, b) => b.createdAtMs - a.createdAtMs);
  const sortedImports = [...importJobs].sort((a, b) => b.createdAtMs - a.createdAtMs);
  const hasCompleted =
    editJobs.some((j) => j.status === 'done' || j.status === 'failed') ||
    importJobs.some((j) => j.status === 'done' || j.status === 'failed');

  function clearAllCompleted() {
    clearEditCompleted();
    clearImportCompleted();
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 300,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 460,
          maxWidth: '90%',
          maxHeight: '78vh',
          background: '#242424',
          borderRadius: 14,
          boxShadow: '0 24px 70px rgba(0,0,0,0.65)',
          border: '1px solid rgba(255,255,255,0.08)',
          display: 'flex',
          flexDirection: 'column',
          color: '#fff',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            padding: '16px 18px',
            borderBottom: '1px solid rgba(255,255,255,0.08)',
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 15, fontWeight: 700 }}>Recent Activity</span>
          <div style={{ flex: 1 }} />
          <div
            onClick={onClose}
            style={{
              width: 26,
              height: 26,
              borderRadius: '50%',
              background: 'rgba(255,255,255,0.08)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'default',
              position: 'relative',
            }}
          >
            <div style={{ position: 'absolute', width: 10, height: 1.6, background: '#fff', transform: 'rotate(45deg)', borderRadius: 1 }} />
            <div style={{ position: 'absolute', width: 10, height: 1.6, background: '#fff', transform: 'rotate(-45deg)', borderRadius: 1 }} />
          </div>
        </div>

        <div style={{ flex: 1, overflow: 'auto', minHeight: 0, padding: '6px 10px' }}>
          <SectionLabel>Edits</SectionLabel>
          {sortedEdits.length === 0 ? (
            <EmptyRow>No edits yet this session.</EmptyRow>
          ) : (
            sortedEdits.map((job) => {
              const pill = statusPill(job.status);
              return (
                <div key={job.jobId} style={rowStyle}>
                  <img
                    src={thumbnailSrc(job.assetId)}
                    alt=""
                    style={{ width: 40, height: 40, borderRadius: 6, objectFit: 'cover', flexShrink: 0, background: '#333' }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={rowTitle}>{kindLabel(job)}</div>
                    {job.error && <div style={rowError}>{job.error}</div>}
                    {job.immichWarning && !job.error && <div style={rowWarning}>{job.immichWarning}</div>}
                  </div>
                  <StatusPill pill={pill} />
                </div>
              );
            })
          )}

          <SectionLabel>Imports</SectionLabel>
          {nudgeError && <div style={{ ...rowWarning, padding: '0 8px 8px' }}>{nudgeError}</div>}
          {sortedImports.length === 0 ? (
            <EmptyRow>No imports yet this session.</EmptyRow>
          ) : (
            sortedImports.map((job: ImportJob) => {
              const pill = importStatusPill(job.status);
              const ext = job.destPath.split('.').pop()?.toUpperCase() ?? '';
              return (
                <div key={job.jobId} style={rowStyle}>
                  <div
                    style={{
                      width: 40,
                      height: 40,
                      borderRadius: 6,
                      flexShrink: 0,
                      background: '#333',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      font: '700 9px ui-monospace,monospace',
                      color: 'rgba(255,255,255,0.6)',
                    }}
                  >
                    {ext}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={rowTitle}>{baseName(job.destPath)}</div>
                    {job.status === 'copying' && (
                      // Real numbers, not just a "Copying…" pill that looks
                      // identical whether it's genuinely advancing or fully
                      // stuck - exactly the ambiguity that made a slow-but-
                      // working link indistinguishable from a hang before
                      // this existed.
                      <div style={rowProgress}>
                        {formatMB(job.bytesCopied)} / {formatMB(job.sizeBytes)} MB
                      </div>
                    )}
                    {job.error && (
                      <div style={rowError}>
                        {job.error}
                        {job.bytesCopied > 0 && ` (got ${formatMB(job.bytesCopied)} / ${formatMB(job.sizeBytes)} MB)`}
                      </div>
                    )}
                  </div>
                  <StatusPill pill={pill} />
                </div>
              );
            })
          )}
        </div>

        <div style={{ padding: '12px 18px', borderTop: '1px solid rgba(255,255,255,0.08)', flexShrink: 0, display: 'flex', justifyContent: 'flex-end' }}>
          <button
            onClick={clearAllCompleted}
            disabled={!hasCompleted}
            style={{
              height: 32,
              padding: '0 14px',
              borderRadius: 8,
              border: 'none',
              background: 'rgba(255,255,255,0.08)',
              color: '#fff',
              fontSize: 12.5,
              cursor: 'default',
              opacity: hasCompleted ? 1 : 0.4,
            }}
          >
            Clear Completed
          </button>
        </div>
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 700,
        color: 'rgba(255,255,255,0.4)',
        textTransform: 'uppercase',
        letterSpacing: '.04em',
        padding: '10px 8px 6px',
      }}
    >
      {children}
    </div>
  );
}

function EmptyRow({ children }: { children: string }) {
  return <div style={{ padding: '10px 8px 18px', color: 'rgba(255,255,255,0.4)', fontSize: 12.5 }}>{children}</div>;
}

function StatusPill({ pill }: { pill: { label: string; color: string; bg: string } }) {
  return (
    <span
      style={{
        flexShrink: 0,
        fontSize: 10.5,
        fontWeight: 700,
        padding: '3px 8px',
        borderRadius: 10,
        color: pill.color,
        background: pill.bg,
      }}
    >
      {pill.label}
    </span>
  );
}

const rowStyle = { display: 'flex', alignItems: 'center', gap: 11, padding: '9px 8px', borderRadius: 9 } as const;
const rowTitle = { fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } as const;
const rowError = { fontSize: 11, color: '#ff8080', marginTop: 2, lineHeight: 1.4 } as const;
const rowWarning = { fontSize: 11, color: '#ffd699', marginTop: 2, lineHeight: 1.4 } as const;
const rowProgress = { fontSize: 11, color: '#9cc2f0', marginTop: 2, font: '500 11px ui-monospace,monospace' } as const;
