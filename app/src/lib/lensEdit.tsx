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

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import CopiedLensCard from '../components/CopiedLensCard';
import LensEditDialog from '../components/LensEditDialog';
import { changeAssetLens, type AssetSummary, type EditJob, type LensEditRequest } from './api';
import { useEditQueue } from './editQueue';
import { useLensConfig } from './lensConfig';
import { readLensNote, upsertLensNote } from './lenses';
import { useEditJobReconciliation } from './useEditJobReconciliation';

// Each browser page keeps its own asset cache, so the page hands over its
// own local-patch function when opening the dialog - that's the only page
// integration Change Lens needs (the optimistic patch and its rollback both
// run through it, from here).
type ApplyPatch = (id: string, patch: Partial<AssetSummary>) => void;

interface OpenArgs {
  assets: AssetSummary[];
  applyPatch: ApplyPatch;
  onError?: (message: string) => void;
  // Set by Paste Lens - the dialog opens filled in from this.
  prefill?: CopiedLens;
}

// What Copy Lens remembers - kept apart from Copy Metadata's patch because a
// lens isn't a plain field copy: it's written through Change Lens (lens
// tags, focal length, optional note, optional original), so Paste Lens opens
// that dialog filled in from this rather than writing straight away. The
// as-shot aperture is deliberately not copied - it varies shot to shot.
export interface CopiedLens {
  fileName: string;
  lensModel: string | null;
  // The lens named in the source's description note, if any - for a coded
  // lens edited with "Keep lens, add note", this is the real lens.
  noteLens: string | null;
  focalLength: number | null;
}

interface LensEditContextValue {
  openLensEditor: (args: OpenArgs) => void;
  // In-memory only, like the rest of the copy/paste clipboard (lib/clipboard.tsx).
  copiedLens: CopiedLens | null;
  // False when the asset has no lens (and no lens note) to copy.
  canCopyLens: (asset: AssetSummary) => boolean;
  copyLens: (asset: AssetSummary) => void;
  // Opens Change Lens on `assets`, prefilled from the copied lens.
  pasteLens: (args: Omit<OpenArgs, 'prefill'>) => void;
}

const LensEditContext = createContext<LensEditContextValue | null>(null);

export function LensEditProvider({ children }: { children: ReactNode }) {
  const { jobs } = useEditQueue();
  const { lensConfig } = useLensConfig();
  const [open, setOpen] = useState<OpenArgs | null>(null);
  const [copiedLens, setCopiedLens] = useState<CopiedLens | null>(null);
  // "Lens copied" confirmation - copying is otherwise invisible (the app has
  // no general toast system). Bumped on every copy so re-copying restarts it.
  const [toastSeq, setToastSeq] = useState(0);
  useEffect(() => {
    if (!toastSeq) return;
    const t = window.setTimeout(() => setToastSeq(0), 3200);
    return () => window.clearTimeout(t);
  }, [toastSeq]);
  const rollbackById = useRef(new Map<number, { id: string; prev: Partial<AssetSummary>; args: OpenArgs }>());

  const { trackJobs } = useEditJobReconciliation(jobs, (job: EditJob) => {
    const entry = rollbackById.current.get(job.jobId);
    rollbackById.current.delete(job.jobId);
    if (!entry || job.status !== 'failed') return;
    entry.args.applyPatch(entry.id, entry.prev);
    entry.args.onError?.(job.error ?? 'Change Lens failed');
  });

  const submit = useCallback(
    async (args: OpenArgs, request: LensEditRequest) => {
      const effectiveFocal = request.focalLength ?? (request.lens.focalMin > 0 && request.lens.focalMin === request.lens.focalMax ? request.lens.focalMin : null);
      const prevById = new Map<string, Partial<AssetSummary>>();
      for (const a of args.assets) {
        const patch: Partial<AssetSummary> = {};
        const prev: Partial<AssetSummary> = {};
        if (request.applyLens) {
          patch.lensModel = request.lens.model;
          prev.lensModel = a.lensModel;
          patch.lensMake = request.lens.maker.trim() || null;
          prev.lensMake = a.lensMake;
          if (effectiveFocal != null) {
            patch.focalLength = effectiveFocal;
            prev.focalLength = a.focalLength;
          }
          if (request.fNumber != null) {
            patch.fNumber = request.fNumber;
            prev.fNumber = a.fNumber;
          }
        }
        if (request.addNote) {
          patch.description = upsertLensNote(a.description ?? '', lensConfig.notePrefix, request.noteLens || request.lens.model);
          prev.description = a.description;
        }
        prevById.set(a.id, prev);
        args.applyPatch(a.id, patch);
      }
      const targets = args.assets.map((a) => ({
        id: a.id,
        originalPath: a.originalPath ?? null,
        make: a.make,
        model: a.model,
        lensModel: a.lensModel,
        description: a.description,
      }));
      try {
        const jobIds = await changeAssetLens(targets, request);
        jobIds.forEach((jobId, i) => {
          const id = args.assets[i].id;
          rollbackById.current.set(jobId, { id, prev: prevById.get(id)!, args });
        });
        trackJobs(jobIds);
      } catch (e) {
        for (const [id, prev] of prevById) args.applyPatch(id, prev);
        throw e;
      }
    },
    [lensConfig.notePrefix, trackJobs],
  );

  const openLensEditor = useCallback((args: OpenArgs) => {
    if (args.assets.length) setOpen(args);
  }, []);

  const canCopyLens = useCallback(
    (asset: AssetSummary) => asset.type !== 'VIDEO' && (!!asset.lensModel?.trim() || readLensNote(asset.description ?? '', lensConfig.notePrefix) != null),
    [lensConfig.notePrefix],
  );

  const copyLens = useCallback(
    (asset: AssetSummary) => {
      if (!canCopyLens(asset)) return;
      setCopiedLens({
        fileName: asset.fileName,
        lensModel: asset.lensModel?.trim() || null,
        noteLens: readLensNote(asset.description ?? '', lensConfig.notePrefix),
        focalLength: asset.focalLength,
      });
      setToastSeq((n) => n + 1);
    },
    [canCopyLens, lensConfig.notePrefix],
  );

  const pasteLens = useCallback(
    (args: Omit<OpenArgs, 'prefill'>) => {
      const assets = args.assets.filter((a) => a.type !== 'VIDEO');
      if (copiedLens && assets.length) setOpen({ ...args, assets, prefill: copiedLens });
    },
    [copiedLens],
  );

  return (
    <LensEditContext.Provider value={{ openLensEditor, copiedLens, canCopyLens, copyLens, pasteLens }}>
      {children}
      {toastSeq > 0 && copiedLens && !open && (
        <div
          key={toastSeq}
          role="status"
          onClick={() => setToastSeq(0)}
          style={{
            position: 'fixed', left: '50%', bottom: 56, transform: 'translateX(-50%)', zIndex: 400,
            width: 'min(440px, calc(100vw - 32px))', borderRadius: 13, background: 'var(--dialog-bg)',
            boxShadow: '0 10px 34px rgba(0,0,0,0.55)', animation: 'lens-toast-in 160ms ease-out',
          }}
        >
          <style>{'@keyframes lens-toast-in { from { opacity: 0; transform: translate(-50%, 10px); } to { opacity: 1; transform: translate(-50%, 0); } }'}</style>
          <CopiedLensCard lens={copiedLens} eyebrow="Lens copied" done />
        </div>
      )}
      {open && <LensEditDialog assets={open.assets} prefill={open.prefill} onClose={() => setOpen(null)} onSubmit={(request) => submit(open, request)} />}
    </LensEditContext.Provider>
  );
}

export function useLensEdit(): LensEditContextValue {
  const ctx = useContext(LensEditContext);
  if (!ctx) throw new Error('useLensEdit must be used within a LensEditProvider');
  return ctx;
}
