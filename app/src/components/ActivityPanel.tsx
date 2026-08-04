import { useEffect, useState } from 'react';
import { useEditQueue } from '../lib/editQueue';
import { useImportQueue } from '../lib/importQueue';
import { useProcessingQueue } from '../lib/processingQueue';
import { useArtQueue } from '../lib/artQueue';
import { useExportQueue } from '../lib/exportQueue';
import {
  cancelRawCliJob,
  cancelExportJob,
  thumbnailSrc,
  type ArtJob,
  type ArtJobStatus,
  type EditJob,
  type ExportJob,
  type ExportJobStatus,
  type ExportTargetKind,
  type ImportJob,
  type ImportJobStatus,
  type ProcessingJobStatus,
  type RawConverterKind,
} from '../lib/api';

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

function processingStatusPill(status: ProcessingJobStatus): { label: string; color: string; bg: string } {
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

function artStatusPill(status: ArtJobStatus): { label: string; color: string; bg: string } {
  switch (status) {
    case 'pending':
      return { label: 'Queued', color: 'rgba(255,255,255,0.6)', bg: 'rgba(255,255,255,0.08)' };
    case 'running':
      return { label: 'Exporting…', color: '#9cc2f0', bg: 'rgba(53,132,228,0.22)' };
    case 'done':
      return { label: 'Done', color: '#8ce0ae', bg: 'rgba(46,194,126,0.18)' };
    case 'failed':
      return { label: 'Failed', color: '#ff8080', bg: 'rgba(224,27,36,0.2)' };
  }
}

// Display label for each job's `tool` field - lets a row read "ART" vs
// "RawTherapee" now that both share this same board/section.
const RAW_CONVERTER_LABEL: Record<RawConverterKind, string> = { art: 'ART', rawtherapee: 'RawTherapee', darktable: 'DarkTable' };

// `art.rs::classify_exit`'s fixed wording for a RAW file whose embedded
// metadata makes ART-cli's bundled Exiv2 crash outright (confirmed live
// against a real Leica M10-R DNG, reproducible with no ImmAture involvement
// at all) - unlike a timeout or a transient NFS hiccup, retrying this exact
// file will fail identically every time, so it reads as "won't export"
// rather than a generic red "Failed" the user might reasonably retry.
function isPermanentArtFailure(error: string | null): boolean {
  return error != null && error.includes("ART-cli crashed reading this RAW file's metadata");
}

// Mirrors art::CANCELLED_BY_USER's exact wording - a cancelled job is still
// `failed` with this as its error text (see art_queue.rs's `finish` call in
// the cancellation branch), so it needs its own check to render as neutral
// "Cancelled" rather than red "Failed".
function isCancelledArtFailure(error: string | null): boolean {
  return error === 'Cancelled by user';
}

// A job the user can still ask to cancel - excludes one that's already
// finished (whether successfully or not) and one that's already had a
// cancellation requested (no point re-selecting it).
function isCancellableArtJob(job: ArtJob): boolean {
  return (job.status === 'pending' || job.status === 'running') && !job.cancelRequested;
}

function exportStatusPill(status: ExportJobStatus, target: ExportTargetKind): { label: string; color: string; bg: string } {
  switch (status) {
    case 'pending':
      return { label: 'Queued', color: 'rgba(255,255,255,0.6)', bg: 'rgba(255,255,255,0.08)' };
    case 'running':
      return { label: target === 'flickr' ? 'Uploading…' : 'Writing…', color: '#9cc2f0', bg: 'rgba(53,132,228,0.22)' };
    case 'done':
      return { label: 'Done', color: '#8ce0ae', bg: 'rgba(46,194,126,0.18)' };
    case 'failed':
      return { label: 'Failed', color: '#ff8080', bg: 'rgba(224,27,36,0.2)' };
  }
}

// Mirrors art::CANCELLED_BY_USER's exact wording - export_queue.rs's worker
// finishes a cancelled job the same way ART round-trip jobs do.
function isCancelledExportFailure(error: string | null): boolean {
  return error === 'Cancelled by user';
}

function isCancellableExportJob(job: ExportJob): boolean {
  return (job.status === 'pending' || job.status === 'running') && !job.cancelRequested;
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
  const { jobs: processingJobs, clearCompleted: clearProcessingCompleted } = useProcessingQueue();
  const { jobs: artJobs, clearCompleted: clearArtCompleted, stalledJobIds } = useArtQueue();
  const { jobs: exportJobs, clearCompleted: clearExportCompleted } = useExportQueue();
  const sortedEdits = [...editJobs].sort((a, b) => b.createdAtMs - a.createdAtMs);
  const sortedImports = [...importJobs].sort((a, b) => b.createdAtMs - a.createdAtMs);
  const sortedProcessing = [...processingJobs].sort((a, b) => b.createdAtMs - a.createdAtMs);
  const sortedArt = [...artJobs].sort((a, b) => b.createdAtMs - a.createdAtMs);
  const sortedExports = [...exportJobs].sort((a, b) => b.createdAtMs - a.createdAtMs);
  const cancellableArtJobIds = sortedArt.filter(isCancellableArtJob).map((j) => j.jobId);
  const [selectedArtJobIds, setSelectedArtJobIds] = useState<Set<number>>(new Set());

  // Drops any selected id that's no longer cancellable (finished on its own,
  // or a cancel was already requested some other way) - otherwise a stale
  // selection would just silently no-op next time "Cancel Selected" runs.
  useEffect(() => {
    setSelectedArtJobIds((prev) => {
      const stillCancellable = new Set(cancellableArtJobIds);
      const next = new Set([...prev].filter((id) => stillCancellable.has(id)));
      return next.size === prev.size ? prev : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artJobs]);

  function toggleArtJobSelected(jobId: number) {
    setSelectedArtJobIds((prev) => {
      const next = new Set(prev);
      if (next.has(jobId)) next.delete(jobId);
      else next.add(jobId);
      return next;
    });
  }

  function cancelSelectedArtJobs() {
    const ids = [...selectedArtJobIds];
    setSelectedArtJobIds(new Set());
    for (const jobId of ids) cancelRawCliJob(jobId).catch(() => {});
  }

  const hasCompleted =
    editJobs.some((j) => j.status === 'done' || j.status === 'failed') ||
    importJobs.some((j) => j.status === 'done' || j.status === 'failed') ||
    processingJobs.some((j) => j.status === 'done' || j.status === 'failed') ||
    artJobs.some((j) => j.status === 'done' || j.status === 'failed') ||
    exportJobs.some((j) => j.status === 'done' || j.status === 'failed');

  function clearAllCompleted() {
    clearEditCompleted();
    clearImportCompleted();
    clearProcessingCompleted();
    clearArtCompleted();
    clearExportCompleted();
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

          <SectionLabel>Processing</SectionLabel>
          {sortedProcessing.length === 0 ? (
            <EmptyRow>No image processing pasted yet this session.</EmptyRow>
          ) : (
            sortedProcessing.map((job) => {
              const pill = processingStatusPill(job.status);
              return (
                <div key={job.jobId} style={rowStyle}>
                  <img
                    src={thumbnailSrc(job.targetAssetId)}
                    alt=""
                    style={{ width: 40, height: 40, borderRadius: 6, objectFit: 'cover', flexShrink: 0, background: '#333' }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={rowTitle}>Paste Image Processing</div>
                    {job.error && <div style={rowError}>{job.error}</div>}
                  </div>
                  <StatusPill pill={pill} />
                </div>
              );
            })
          )}

          <SectionLabel>RAW Round Trip</SectionLabel>
          {sortedArt.length === 0 ? (
            <EmptyRow>No RAW round trips yet this session.</EmptyRow>
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'center', padding: '0 8px 6px', gap: 10 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'rgba(255,255,255,0.6)', cursor: 'default' }}>
                  <input
                    type="checkbox"
                    checked={cancellableArtJobIds.length > 0 && selectedArtJobIds.size === cancellableArtJobIds.length}
                    disabled={cancellableArtJobIds.length === 0}
                    onChange={(e) => setSelectedArtJobIds(e.target.checked ? new Set(cancellableArtJobIds) : new Set())}
                  />
                  Select All
                </label>
                <div style={{ flex: 1 }} />
                <button
                  onClick={cancelSelectedArtJobs}
                  disabled={selectedArtJobIds.size === 0}
                  style={{
                    height: 26,
                    padding: '0 10px',
                    borderRadius: 7,
                    border: 'none',
                    background: 'rgba(224,27,36,0.18)',
                    color: '#ff8080',
                    fontSize: 11.5,
                    fontWeight: 600,
                    cursor: 'default',
                    opacity: selectedArtJobIds.size === 0 ? 0.4 : 1,
                  }}
                >
                  Cancel Selected{selectedArtJobIds.size > 0 ? ` (${selectedArtJobIds.size})` : ''}
                </button>
              </div>
              {sortedArt.map((job) => {
                const permanent = job.status === 'failed' && isPermanentArtFailure(job.error);
                const cancelled = job.status === 'failed' && isCancelledArtFailure(job.error);
                const cancelling = (job.status === 'pending' || job.status === 'running') && job.cancelRequested;
                const stalled = job.status === 'running' && !cancelling && stalledJobIds.has(job.jobId);
                const neutralPill = { label: '', color: 'rgba(255,255,255,0.6)', bg: 'rgba(255,255,255,0.08)' };
                const pill = permanent
                  ? { label: "Won't Export", color: '#ffd699', bg: 'rgba(255,169,15,0.18)' }
                  : cancelled
                    ? { ...neutralPill, label: 'Cancelled' }
                    : cancelling
                      ? { ...neutralPill, label: 'Cancelling…' }
                      : stalled
                        ? { label: 'Stalled?', color: '#ffd699', bg: 'rgba(255,169,15,0.18)' }
                        : artStatusPill(job.status);
                // Real percentage (parsed backend-side from ART-cli's own
                // --progress output), not just a "Exporting…" pill that looks
                // identical whether it's genuinely advancing or stuck -
                // matching the Imports section's real-byte-count treatment.
                if (job.status === 'running' && !stalled && !cancelling && job.progressPercent != null) {
                  pill.label = `${job.progressPercent}%`;
                }
                const cancellable = isCancellableArtJob(job);
                return (
                  <div key={job.jobId} style={rowStyle}>
                    {cancellable ? (
                      <input
                        type="checkbox"
                        checked={selectedArtJobIds.has(job.jobId)}
                        onChange={() => toggleArtJobSelected(job.jobId)}
                        style={{ flexShrink: 0 }}
                      />
                    ) : (
                      <div style={{ width: 13, flexShrink: 0 }} />
                    )}
                    <img
                      src={thumbnailSrc(job.assetId)}
                      alt=""
                      style={{ width: 40, height: 40, borderRadius: 6, objectFit: 'cover', flexShrink: 0, background: '#333' }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={rowTitle}>{job.exportFileName ?? 'RAW Roundtrip'}</div>
                      <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginTop: 1 }}>{RAW_CONVERTER_LABEL[job.tool]}</div>
                      {job.error && !cancelled && <div style={permanent ? rowWarning : rowError}>{job.error}</div>}
                      {!job.error && stalled && (
                        <div style={rowWarning}>
                          No progress in a while — this can happen when the RAW or export folder lives on a network drive
                          that's slow or briefly unreachable. It'll keep waiting up to 20 minutes before giving up.
                        </div>
                      )}
                    </div>
                    <StatusPill pill={pill} />
                  </div>
                );
              })}
            </>
          )}

          <SectionLabel>Export</SectionLabel>
          {sortedExports.length === 0 ? (
            <EmptyRow>No exports yet this session.</EmptyRow>
          ) : (
            sortedExports.map((job) => {
              const cancelled = job.status === 'failed' && isCancelledExportFailure(job.error);
              const cancelling = (job.status === 'pending' || job.status === 'running') && job.cancelRequested;
              const neutralPill = { label: '', color: 'rgba(255,255,255,0.6)', bg: 'rgba(255,255,255,0.08)' };
              const pill = cancelled
                ? { ...neutralPill, label: 'Cancelled' }
                : cancelling
                  ? { ...neutralPill, label: 'Cancelling…' }
                  : exportStatusPill(job.status, job.target);
              const cancellable = isCancellableExportJob(job);
              return (
                <div key={job.jobId} style={rowStyle}>
                  <img
                    src={thumbnailSrc(job.assetId)}
                    alt=""
                    style={{ width: 40, height: 40, borderRadius: 6, objectFit: 'cover', flexShrink: 0, background: '#333' }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={rowTitle}>{job.exportFileName ?? (job.target === 'flickr' ? 'Share to Flickr' : 'Export to Folder')}</div>
                    <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginTop: 1 }}>
                      {job.target === 'flickr' ? 'Flickr' : 'Folder'}
                    </div>
                    {job.error && !cancelled && <div style={rowError}>{job.error}</div>}
                  </div>
                  {cancellable && !cancelling && (
                    <button
                      onClick={() => cancelExportJob(job.jobId).catch(() => {})}
                      style={{
                        flexShrink: 0,
                        height: 22,
                        padding: '0 8px',
                        borderRadius: 6,
                        border: 'none',
                        background: 'rgba(255,255,255,0.08)',
                        color: 'rgba(255,255,255,0.7)',
                        fontSize: 10.5,
                        cursor: 'default',
                      }}
                    >
                      Cancel
                    </button>
                  )}
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
