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

import { useEffect, useState } from 'react';
import { useEditQueue } from '../lib/editQueue';
import { useImportQueue } from '../lib/importQueue';
import { useProcessingQueue } from '../lib/processingQueue';
import { useArtQueue } from '../lib/artQueue';
import { useExportQueue } from '../lib/exportQueue';
import { useStackQueue } from '../lib/stackQueue';
import {
  cancelRawCliJob,
  cancelExportJob,
  RAW_CONVERTER_LABEL,
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
  type StackJob,
  type StackJobStatus,
} from '../lib/api';

// Same "quiet placeholder beats the browser's broken-image glyph" idiom as
// AssetThumb.tsx's grid/filmstrip thumbnails, adapted for this panel's fixed
// 40x40 row thumbnails (no absolute-positioned thumbhash blur layer needed
// here - these rows are transient session history, not scroll-heavy grid
// tiles). A 404 here is expected, not a bug: this panel's job history is a
// plain in-memory session log with no asset-lifecycle awareness, so an id
// from an edit/round-trip/export queued earlier in the session can easily
// outlive the asset itself (trashed/deleted since) - Immich then correctly
// 404s its thumbnail forever, not just transiently, so this has no retry
// affordance (unlike AssetThumb's ⟳, which is for a thumbnail still being
// generated and worth asking for again).
function RowThumb({ assetId }: { assetId: string }) {
  const [failed, setFailed] = useState(false);
  return failed ? (
    <div
      style={{
        width: 40,
        height: 40,
        borderRadius: 6,
        flexShrink: 0,
        background: 'var(--surface-sunken)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--text-dimmer)',
        fontSize: 16,
      }}
    >
      ⌀
    </div>
  ) : (
    <img
      src={thumbnailSrc(assetId)}
      alt=""
      onError={() => setFailed(true)}
      style={{ width: 40, height: 40, borderRadius: 6, objectFit: 'cover', flexShrink: 0, background: 'var(--surface-sunken)' }}
    />
  );
}

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
      return { label: 'Queued', color: 'var(--text-dim)', bg: 'var(--overlay-medium)' };
    case 'writing':
      return { label: 'Syncing…', color: 'var(--accent-text)', bg: 'rgba(53,132,228,0.22)' };
    case 'done':
      return { label: 'Done', color: '#8ce0ae', bg: 'rgba(46,194,126,0.18)' };
    case 'failed':
      return { label: 'Failed', color: '#ff8080', bg: 'rgba(224,27,36,0.2)' };
  }
}

function importStatusPill(status: ImportJobStatus): { label: string; color: string; bg: string } {
  switch (status) {
    case 'pending':
      return { label: 'Queued', color: 'var(--text-dim)', bg: 'var(--overlay-medium)' };
    case 'copying':
      return { label: 'Copying…', color: 'var(--accent-text)', bg: 'rgba(53,132,228,0.22)' };
    case 'done':
      return { label: 'Done', color: '#8ce0ae', bg: 'rgba(46,194,126,0.18)' };
    case 'failed':
      return { label: 'Failed', color: '#ff8080', bg: 'rgba(224,27,36,0.2)' };
  }
}

function processingStatusPill(status: ProcessingJobStatus): { label: string; color: string; bg: string } {
  switch (status) {
    case 'pending':
      return { label: 'Queued', color: 'var(--text-dim)', bg: 'var(--overlay-medium)' };
    case 'copying':
      return { label: 'Copying…', color: 'var(--accent-text)', bg: 'rgba(53,132,228,0.22)' };
    case 'done':
      return { label: 'Done', color: '#8ce0ae', bg: 'rgba(46,194,126,0.18)' };
    case 'failed':
      return { label: 'Failed', color: '#ff8080', bg: 'rgba(224,27,36,0.2)' };
  }
}

function artStatusPill(status: ArtJobStatus): { label: string; color: string; bg: string } {
  switch (status) {
    case 'pending':
      return { label: 'Queued', color: 'var(--text-dim)', bg: 'var(--overlay-medium)' };
    case 'running':
      return { label: 'Exporting…', color: 'var(--accent-text)', bg: 'rgba(53,132,228,0.22)' };
    case 'done':
      return { label: 'Done', color: '#8ce0ae', bg: 'rgba(46,194,126,0.18)' };
    case 'failed':
      return { label: 'Failed', color: '#ff8080', bg: 'rgba(224,27,36,0.2)' };
  }
}

// `art.rs::classify_exit`'s fixed wording for a RAW file whose embedded
// metadata makes ART-cli's bundled Exiv2 crash outright (confirmed live
// against a real Leica M10-R DNG, reproducible with no BrightTable involvement
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
      return { label: 'Queued', color: 'var(--text-dim)', bg: 'var(--overlay-medium)' };
    case 'running':
      return { label: target === 'flickr' ? 'Uploading…' : 'Writing…', color: 'var(--accent-text)', bg: 'rgba(53,132,228,0.22)' };
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

// A stack job has no single asset/filename the way every other queue's row
// does - Dissolve's asset count isn't known until it settles (resultMemberIds),
// but Create's is known immediately from its own kind.
function stackKindLabel(job: StackJob): string {
  if (job.kind.kind === 'dissolve') {
    const count = job.resultMemberIds?.length;
    return count != null ? `Unstack (${count} photo${count === 1 ? '' : 's'})` : 'Unstack';
  }
  const count = job.kind.assetIds.length;
  return `Stack (${count} photo${count === 1 ? '' : 's'})`;
}

function stackStatusPill(status: StackJobStatus): { label: string; color: string; bg: string } {
  switch (status) {
    case 'pending':
      return { label: 'Queued', color: 'var(--text-dim)', bg: 'var(--overlay-medium)' };
    case 'working':
      return { label: 'Working…', color: 'var(--accent-text)', bg: 'rgba(53,132,228,0.22)' };
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
  const { jobs: processingJobs, clearCompleted: clearProcessingCompleted } = useProcessingQueue();
  const { jobs: artJobs, clearCompleted: clearArtCompleted, stalledJobIds } = useArtQueue();
  const { jobs: exportJobs, clearCompleted: clearExportCompleted } = useExportQueue();
  const { jobs: stackJobs, clearCompleted: clearStackCompleted } = useStackQueue();
  const sortedEdits = [...editJobs].sort((a, b) => b.createdAtMs - a.createdAtMs);
  const sortedImports = [...importJobs].sort((a, b) => b.createdAtMs - a.createdAtMs);
  const sortedProcessing = [...processingJobs].sort((a, b) => b.createdAtMs - a.createdAtMs);
  const sortedArt = [...artJobs].sort((a, b) => b.createdAtMs - a.createdAtMs);
  const sortedExports = [...exportJobs].sort((a, b) => b.createdAtMs - a.createdAtMs);
  const sortedStacks = [...stackJobs].sort((a, b) => b.createdAtMs - a.createdAtMs);
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
    exportJobs.some((j) => j.status === 'done' || j.status === 'failed') ||
    stackJobs.some((j) => j.status === 'done' || j.status === 'failed');

  function clearAllCompleted() {
    clearEditCompleted();
    clearImportCompleted();
    clearProcessingCompleted();
    clearArtCompleted();
    clearExportCompleted();
    clearStackCompleted();
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
          background: 'var(--dialog-bg)',
          borderRadius: 14,
          boxShadow: '0 24px 70px rgba(0,0,0,0.65)',
          border: '1px solid var(--border)',
          display: 'flex',
          flexDirection: 'column',
          color: 'var(--text)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            padding: '16px 18px',
            borderBottom: '1px solid var(--border)',
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
              background: 'var(--overlay-medium)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'default',
              position: 'relative',
            }}
          >
            <div style={{ position: 'absolute', width: 10, height: 1.6, background: 'var(--text)', transform: 'rotate(45deg)', borderRadius: 1 }} />
            <div style={{ position: 'absolute', width: 10, height: 1.6, background: 'var(--text)', transform: 'rotate(-45deg)', borderRadius: 1 }} />
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
                  <RowThumb assetId={job.assetId} />
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
                      background: 'var(--surface-sunken)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      font: '700 9px ui-monospace,monospace',
                      color: 'var(--text-dim)',
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
                  <RowThumb assetId={job.targetAssetId} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={rowTitle}>Paste Image Processing</div>
                    <div style={{ fontSize: 11, color: 'var(--text-dimmer)', marginTop: 1 }}>{RAW_CONVERTER_LABEL[job.tool]}</div>
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
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--text-dim)', cursor: 'default' }}>
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
                const neutralPill = { label: '', color: 'var(--text-dim)', bg: 'var(--overlay-medium)' };
                const pill = permanent
                  ? { label: "Won't Export", color: 'var(--warn)', bg: 'rgba(255,169,15,0.18)' }
                  : cancelled
                    ? { ...neutralPill, label: 'Cancelled' }
                    : cancelling
                      ? { ...neutralPill, label: 'Cancelling…' }
                      : stalled
                        ? { label: 'Stalled?', color: 'var(--warn)', bg: 'rgba(255,169,15,0.18)' }
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
                    <RowThumb assetId={job.assetId} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={rowTitle}>{job.exportFileName ?? 'RAW Roundtrip'}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-dimmer)', marginTop: 1 }}>{RAW_CONVERTER_LABEL[job.tool]}</div>
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
              const neutralPill = { label: '', color: 'var(--text-dim)', bg: 'var(--overlay-medium)' };
              const pill = cancelled
                ? { ...neutralPill, label: 'Cancelled' }
                : cancelling
                  ? { ...neutralPill, label: 'Cancelling…' }
                  : exportStatusPill(job.status, job.target);
              const cancellable = isCancellableExportJob(job);
              return (
                <div key={job.jobId} style={rowStyle}>
                  <RowThumb assetId={job.assetId} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={rowTitle}>{job.exportFileName ?? (job.target === 'flickr' ? 'Share to Flickr' : 'Export to Folder')}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-dimmer)', marginTop: 1 }}>
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
                        background: 'var(--overlay-medium)',
                        color: 'var(--text-dim)',
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

          <SectionLabel>Stacks</SectionLabel>
          {sortedStacks.length === 0 ? (
            <EmptyRow>No stacking activity yet this session.</EmptyRow>
          ) : (
            sortedStacks.map((job) => {
              const pill = stackStatusPill(job.status);
              return (
                <div key={job.jobId} style={rowStyle}>
                  <div
                    style={{
                      width: 40,
                      height: 40,
                      borderRadius: 6,
                      flexShrink: 0,
                      background: 'var(--surface-sunken)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      position: 'relative',
                    }}
                  >
                    <div style={{ position: 'relative', width: 13, height: 12 }}>
                      <div style={{ position: 'absolute', left: 0, top: 0, width: 9, height: 9, border: '1.6px solid var(--text-dim)', borderRadius: 2 }} />
                      <div
                        style={{
                          position: 'absolute',
                          left: 4,
                          top: 3,
                          width: 9,
                          height: 9,
                          border: '1.6px solid var(--text-dim)',
                          borderRadius: 2,
                          background: 'var(--surface-sunken)',
                        }}
                      />
                    </div>
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={rowTitle}>{stackKindLabel(job)}</div>
                    {job.error && <div style={rowError}>{job.error}</div>}
                  </div>
                  <StatusPill pill={pill} />
                </div>
              );
            })
          )}
        </div>

        <div style={{ padding: '12px 18px', borderTop: '1px solid var(--border)', flexShrink: 0, display: 'flex', justifyContent: 'flex-end' }}>
          <button
            onClick={clearAllCompleted}
            disabled={!hasCompleted}
            style={{
              height: 32,
              padding: '0 14px',
              borderRadius: 8,
              border: 'none',
              background: 'var(--overlay-medium)',
              color: 'var(--text)',
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
        color: 'var(--text-dimmer)',
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
  return <div style={{ padding: '10px 8px 18px', color: 'var(--text-dimmer)', fontSize: 12.5 }}>{children}</div>;
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
const rowWarning = { fontSize: 11, color: 'var(--warn)', marginTop: 2, lineHeight: 1.4 } as const;
const rowProgress = { fontSize: 11, color: 'var(--accent-text)', marginTop: 2, font: '500 11px ui-monospace,monospace' } as const;
